/**
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import path from "path";
import type webpack from "webpack";
import ForkTsCheckerPlugin from "fork-ts-checker-webpack-plugin";
import nodeExternals from "webpack-node-externals";
import { getTypescriptLoader } from "./get-typescript-loader";
import CircularDependencyPlugin from "circular-dependency-plugin";
import { iconsAndImagesWebpackRules } from "./renderer";
import type { WebpackPluginInstance } from "webpack";
import { DefinePlugin } from "webpack";
import { additionalExternals, buildDir, isDevelopment, mainDir } from "./vars";
import { platform } from "process";

const main = ({ showVars = true } = {}): webpack.Configuration => {
  if (showVars) {
    console.info("WEBPACK:main", {
      isDevelopment,
      mainDir,
      buildDir,
    });
  }

  return {
    name: "lens-app-main",
    context: __dirname,
    target: "electron-main",
    mode: isDevelopment ? "development" : "production",
    devtool: isDevelopment ? "cheap-module-source-map" : "source-map",
    cache: isDevelopment ? { type: "filesystem" } : false,
    entry: {
      main: path.resolve(mainDir, "index.ts"),
    },
    output: {
      libraryTarget: "global",
      path: buildDir,
    },
    resolve: {
      extensions: [".json", ".js", ".ts"],
    },
    externals: [
      nodeExternals(),
      ...additionalExternals,
    ],
    module: {
      parser: {
        javascript: {
          commonjsMagicComments: true,
        },
      },
      rules: [
        {
          test: /\.node$/,
          use: "node-loader",
        },
        getTypescriptLoader({}, /\.ts$/),
        ...iconsAndImagesWebpackRules(),
      ],
    },
    plugins: [
      new DefinePlugin({
        CONTEXT_MATCHER_FOR_NON_FEATURES: `/\\.injectable(\\.${platform})?\\.tsx?$/`,
        CONTEXT_MATCHER_FOR_FEATURES: `/\\/(main|common)\\/.+\\.injectable(\\.${platform})?\\.tsx?$/`,
      }),
      new ForkTsCheckerPlugin(),
      new CircularDependencyPlugin({
        cwd: __dirname,
        exclude: /node_modules/,
        failOnError: true,
      }) as unknown as WebpackPluginInstance,
    ],
  };
};

export default main;
