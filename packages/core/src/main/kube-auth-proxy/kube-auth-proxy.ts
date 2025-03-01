/**
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type { ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import type { Cluster } from "../../common/cluster/cluster";
import type { GetPortFromStream } from "../utils/get-port-from-stream.injectable";
import { makeObservable, observable, when } from "mobx";
import type { SelfSignedCert } from "selfsigned";
import assert from "assert";
import { TypedRegEx } from "typed-regex";
import type { Spawn } from "../child-process/spawn.injectable";
import type { Logger } from "../../common/logger";
import type { WaitUntilPortIsUsed } from "./wait-until-port-is-used/wait-until-port-is-used.injectable";

const startingServeMatcher = "starting to serve on (?<address>.+)";
const startingServeRegex = Object.assign(TypedRegEx(startingServeMatcher, "i"), {
  rawMatcher: startingServeMatcher,
});

export interface KubeAuthProxyDependencies {
  readonly proxyBinPath: string;
  readonly proxyCert: SelfSignedCert;
  readonly logger: Logger;
  spawn: Spawn;
  waitUntilPortIsUsed: WaitUntilPortIsUsed;
  getPortFromStream: GetPortFromStream;
}

export class KubeAuthProxy {
  public readonly apiPrefix = `/${randomBytes(8).toString("hex")}`;

  public get port(): number {
    const port = this._port;

    assert(port, "port has not yet been initialized");

    return port;
  }

  protected _port?: number;
  protected proxyProcess?: ChildProcess;
  @observable protected ready = false;

  constructor(private readonly dependencies: KubeAuthProxyDependencies, protected readonly cluster: Cluster, protected readonly env: NodeJS.ProcessEnv) {
    makeObservable(this);
  }

  get whenReady() {
    return when(() => this.ready);
  }

  public async run(): Promise<void> {
    if (this.proxyProcess) {
      return this.whenReady;
    }

    const proxyBin = this.dependencies.proxyBinPath;
    const cert = this.dependencies.proxyCert;

    this.proxyProcess = this.dependencies.spawn(proxyBin, [], {
      env: {
        ...this.env,
        KUBECONFIG: this.cluster.kubeConfigPath,
        KUBECONFIG_CONTEXT: this.cluster.contextName,
        API_PREFIX: this.apiPrefix,
        PROXY_KEY: cert.private,
        PROXY_CERT: cert.cert,
      },
    });
    this.proxyProcess.on("error", (error) => {
      this.cluster.broadcastConnectUpdate(error.message, "error");
      this.exit();
    });

    this.proxyProcess.on("exit", (code) => {
      this.cluster.broadcastConnectUpdate(`proxy exited with code: ${code}`, code ? "error" : "info");
      this.exit();
    });

    this.proxyProcess.on("disconnect", () => {
      this.cluster.broadcastConnectUpdate("Proxy disconnected communications", "error");
      this.exit();
    });

    assert(this.proxyProcess.stderr);
    assert(this.proxyProcess.stdout);

    this.proxyProcess.stderr.on("data", (data: Buffer) => {
      if (data.includes("http: TLS handshake error")) {
        return;
      }

      this.cluster.broadcastConnectUpdate(data.toString(), "error");
    });

    this.proxyProcess.stdout.on("data", (data: Buffer) => {
      if (typeof this._port === "number") {
        this.cluster.broadcastConnectUpdate(data.toString());
      }
    });

    this._port = await this.dependencies.getPortFromStream(this.proxyProcess.stdout, {
      lineRegex: startingServeRegex,
      onFind: () => this.cluster.broadcastConnectUpdate("Authentication proxy started"),
    });

    this.dependencies.logger.info(`[KUBE-AUTH-PROXY]: found port=${this._port}`);

    try {
      await this.dependencies.waitUntilPortIsUsed(this.port, 500, 10000);
      this.ready = true;
    } catch (error) {
      this.dependencies.logger.warn("[KUBE-AUTH-PROXY]: waitUntilUsed failed", error);
      this.cluster.broadcastConnectUpdate("Proxy port failed to be used within timelimit, restarting...", "error");
      this.exit();

      return this.run();
    }
  }

  public exit() {
    this.ready = false;

    if (this.proxyProcess) {
      this.dependencies.logger.debug("[KUBE-AUTH]: stopping local proxy", this.cluster.getMeta());
      this.proxyProcess.removeAllListeners();
      this.proxyProcess.stderr?.removeAllListeners();
      this.proxyProcess.stdout?.removeAllListeners();
      this.proxyProcess.kill();
      this.proxyProcess = undefined;
    }
  }
}
