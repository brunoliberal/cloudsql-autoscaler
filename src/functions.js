/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

/**
 * @fileoverview
 * CloudSQL Autoscaler
 *
 * Entry points for Cloud Run functions invocations.
 */

const poller = require("./poller/poller-core");
const scaler = require("./scaler/scaler-core");
const { logger } = require("./autoscaler-common/logger");
const { version: packageVersion } = require("../package.json");

logger.info(`CloudSQL autoscaler v${packageVersion} started`);

module.exports = {
  checkCloudSQLScaleMetricsPubSub: poller.checkCloudSQLScaleMetricsPubSub,
  checkCloudSQLScaleMetricsHTTP: poller.checkCloudSQLScaleMetricsHTTP,

  scaleCloudSQLInstancePubSub: scaler.scaleCloudSQLInstancePubSub,
  scaleCloudSQLInstanceHTTP: scaler.scaleCloudSQLInstanceHTTP,
};
