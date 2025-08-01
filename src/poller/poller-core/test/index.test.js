/*
 *
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

/*
 * ESLINT: Ignore max line length errors on lines starting with 'it('
 * (test descriptions)
 */
/* eslint max-len: ["error", { "ignorePattern": "^\\s*it\\(" }] */

const rewire = require("rewire");
// eslint-disable-next-line no-unused-vars
const should = require("should");
const sinon = require("sinon");
const { ValidationError } = require("../config-validator");

const app = rewire("../index.js");

/**
 * @typedef {import('../../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../../../autoscaler-common/types').CloudSQLMetric
 * } CloudSQLMetric
 * @typedef {import('../../../autoscaler-common/types').CloudSQLMetricValue
 * } CloudSQLMetricValue
 */

const buildMetrics = app.__get__("buildMetrics");
/** @type {function(string): Promise<AutoscalerCloudSQL[]>} */
const parseAndEnrichPayload = app.__get__("parseAndEnrichPayload");
const validateCustomMetric = app.__get__("validateCustomMetric");

describe("#buildMetrics", () => {
  it("should return 1 metric", () => {
    buildMetrics("fakeProjectId", "fakeInstanceId").should.have.length(1);
  });

  it("should insert the projectId", () => {
    buildMetrics("fakeProjectId", "fakeInstanceId")[0].filter.should.have.match(
      /fakeProjectId/,
    );
  });
});

describe("#validateCustomMetric", () => {
  it("should return false if name is missing", () => {
    validateCustomMetric({
      filter: "my filter",
      regional_threshold: 10,
    }).should.be.false();
  });

  it("should return false if filter is blank", () => {
    validateCustomMetric({
      name: "custom_filter",
      filter: "",
      regional_threshold: 10,
    }).should.be.false();
  });

  it("should return false if thresholds are missing", () => {
    validateCustomMetric({
      name: "custom_filter",
      filter: "my filter",
    }).should.be.false();
  });

  it("should return false if thresholds are less than equal to 0", () => {
    validateCustomMetric({
      name: "custom_filter",
      filter: "my filter",
      regional_threshold: 0,
    }).should.be.false();
  });

  it("should return true all fields are present and valid", () => {
    validateCustomMetric({
      name: "custom_filter",
      filter: "my filter",
      multi_regional_threshold: 50,
    }).should.be.true();
  });
});

describe("#parseAndEnrichPayload", () => {
  it("should return the default for stepSize", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        minSize: 10,
      },
    ]);

    const stub = sinon.stub().resolves({ currentNode: 5, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    should(mergedConfig[0].stepSize).equal(2);

    unset();
  });

  it("should merge in defaults for processing units", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        units: "VCPU",
        minSize: 2,
      },
    ]);

    const stub = sinon.stub().resolves({ currentSize: 500, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    should(mergedConfig[0].minSize).equal(2);
    should(mergedConfig[0].maxSize).equal(8);
    should(mergedConfig[0].stepSize).equal(2);

    unset();
  });

  it("should override the regional threshold for cpu", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        minSize: 10,
        metrics: [
          {
            name: "cpu",
            regional_threshold: 10,
            multi_regional_threshold: 10,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({ currentNode: 5, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    const mergedConfig = await parseAndEnrichPayload(payload);

    let idx = mergedConfig[0].metrics.findIndex((x) => x.name === "cpu");

    let metric = /** @type {CloudSQLMetric} */ (mergedConfig[0].metrics[idx]);
    metric.regional_threshold.should.equal(10);
    metric.multi_regional_threshold.should.equal(10);

    unset();
  });

  it("should add a custom metric to the list if metric name is a default metric", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        minSize: 10,
        metrics: [
          {
            filter: "my super cool filter",
            name: "bogus",
            multi_regional_threshold: 20,
            regional_threshold: 20,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({ currentNode: 5, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === "bogus");
    const metric = /** @type {CloudSQLMetric} */ (mergedConfig[0].metrics[idx]);
    metric.multi_regional_threshold.should.equal(20);
    unset();
  });

  it("should not add a custom metric to the list if the provided metric is not valid", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        minSize: 10,
        metrics: [
          {
            name: "bogus",
            regional_threshold: 10,
            multi_regional_threshold: 20,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({ currentNode: 5, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === "bogus");
    idx.should.equal(-1);
    unset();
  });

  it("should throw if the nodes are specified if units is set something other than nodes or processing units", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        units: "BOGUS",
        minSize: 200,
      },
    ]);

    const stub = sinon.stub().resolves({ currentSize: 500, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        "Invalid Autoscaler Configuration parameters:\n" +
          "CloudSQLConfig/0/units must be equal to one of the allowed values",
      ),
    );

    unset();
  });

  it("should throw if the sizes are specified as strings", async () => {
    const payload = JSON.stringify([
      {
        projectId: "my-cloudsql-project",
        instanceId: "cloudsql1",
        scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
        units: "VCPU",
        minSize: "300",
      },
    ]);

    const stub = sinon.stub().resolves({ currentSize: 500, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        "Invalid Autoscaler Configuration parameters:\n" +
          "CloudSQLConfig/0/minSize must be number",
      ),
    );

    unset();
  });

  it("should throw if the config is not an array", async () => {
    const payload = JSON.stringify({
      projectId: "my-cloudsql-project",
      instanceId: "cloudsql1",
      scalerPubSubTopic: "projects/my-project/topics/cloudsql-scaling",
      units: "NODES",
      minSize: "300",
    });

    const stub = sinon.stub().resolves({ currentSize: 500, regional: true });
    const unset = app.__set__("getCloudSQLMetadata", stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        "Invalid Autoscaler Configuration parameters:\n" +
          "CloudSQLConfig must be array",
      ),
    );

    unset();
  });
});
