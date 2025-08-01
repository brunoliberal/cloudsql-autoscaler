// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @enum {string}
 */
const AutoscalerUnits = {
  VCPU: "VCPU",
};

/**
 * @typedef {{
 *    currentSize: number,
 *    regional: boolean,
 *    currentNumDatabases: number,
 *  }} CloudSQLMetadata
 */

/**
 * @typedef {{
 *   name: string,
 *   filter: string,
 *   reducer: string,
 *   aligner: string,
 *   period: number,
 *   regional_threshold: number,
 *   regional_margin?: number,
 *   multi_regional_threshold: number,
 *   multi_regional_margin?: number,
 * }} CloudSQLMetric
 */

/**
 * @typedef {{
 *    name: string,
 *    threshold: number,
 *    margin: number,
 *    value: number
 * }} CloudSQLMetricValue
 */

/**
 * @typedef {{
 *      name: string,
 *      instanceId?: string,
 *      databaseId?: string
 * }} StateDatabaseConfig
 */

/**
 * @typedef {{
 *    scalingMethod: string,
 *    projectId: string,
 *    instanceId: string,
 *    units: AutoscalerUnits,
 *    downstreamPubSubTopic?: string,
 *    scalerURL?: string,
 *    scalerPubSubTopic?: string,
 *    scaleOutCoolingMinutes: number,
 *    scaleInCoolingMinutes: number,
 *    overloadCoolingMinutes: number,
 *    stateProjectId?: string,
 *    stateDatabase?: StateDatabaseConfig,
 *    minSize: number,
 *    maxSize: number,
 *    scaleInLimit?: number,
 *    stepSize: number,
 *    overloadStepSize: number,
 *    metrics: (CloudSQLMetric | CloudSQLMetricValue)[],
 * }} CloudSQLConfig;
 */

/**
 * @typedef {{
 *    isOverloaded: boolean,
 * }} CloudSQLData
 */

/**
 * @typedef {CloudSQLConfig & CloudSQLMetadata & CloudSQLData
 * } AutoscalerCloudSQL
 */

module.exports = {
  AutoscalerUnits,
};
