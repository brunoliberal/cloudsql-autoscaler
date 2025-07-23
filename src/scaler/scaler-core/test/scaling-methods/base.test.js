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
require("should");
const sinon = require("sinon");

/**
 * @typedef {import('../../../../autoscaler-common/types').AutoscalerCloudSQL
 * } AutoscalerCloudSQL
 * @typedef {import('../../../../autoscaler-common/types').CloudSQLMetricValue
 * } CloudSQLMetricValue
 * @typedef {import('../../../../autoscaler-common/types').CloudSQLMetric
 * } CloudSQLMetric
 */

const app = rewire("../../scaling-methods/base.js");

const compareMetricValueWithRange = app.__get__("compareMetricValueWithRange");
describe("#compareMetricValueWithRange", () => {
  it("should return WITHIN when value is within range", () => {
    compareMetricValueWithRange({
      value: 70,
      threshold: 65,
      margin: 5,
    }).should.equal("WITHIN");
  });

  it("should return ABOVE when value is above range", () => {
    compareMetricValueWithRange({
      value: 80,
      threshold: 65,
      margin: 5,
    }).should.equal("ABOVE");
  });

  it("should return BELOW when value is below range", () => {
    compareMetricValueWithRange({
      value: 20,
      threshold: 65,
      margin: 5,
    }).should.equal("BELOW");
  });
});

const metricValueWithinRange = app.__get__("metricValueWithinRange");
describe("#metricValueWithinRange", () => {
  it("should return true when metric falls within margins", () => {
    metricValueWithinRange({
      value: 63,
      threshold: 65,
      margin: 5,
    }).should.be.true();
  });

  it("should return false when metric falls outside of the margins", () => {
    metricValueWithinRange({
      value: 15,
      threshold: 45,
      margin: 10,
    }).should.be.false();
  });

  it("should return true when metric falls right at the edge", () => {
    metricValueWithinRange({
      value: 70,
      threshold: 65,
      margin: 5,
    }).should.be.true();
  });
});

const getRange = app.__get__("getRange");
describe("#getRange", () => {
  it("should return a correct range: [th - margin, th + margin]", () => {
    const range = getRange(65, 5);
    range.should.have.property("min").which.is.a.Number().and.equal(60);
    range.should.have.property("max").which.is.a.Number().and.equal(70);
  });

  it("should return a max value of 100: [th - margin, 100]", () => {
    const range = getRange(80, 30);
    range.should.have.property("min").which.is.a.Number().and.equal(50);
    range.should.have.property("max").which.is.a.Number().and.equal(100);
  });

  it("should return a min value of 0: [0, th + margin]", () => {
    const range = getRange(20, 30);
    range.should.have.property("min").which.is.a.Number().and.equal(0);
    range.should.have.property("max").which.is.a.Number().and.equal(50);
  });
});

const getScaleSuggestionMessage = app.__get__("getScaleSuggestionMessage");
describe("#getScaleSuggestionMessage", () => {
  it("should suggest no change when metric value within range", () => {
    getScaleSuggestionMessage({}, 999, "WITHIN").should.containEql("no change");
  });

  // VCPUs --------------------------------------------------
  it("should not suggest scaling when vcpu suggestion is equal to current", () => {
    const msg = getScaleSuggestionMessage(
      { units: "VCPU", currentSize: 3, minSize: 2, maxSize: 8 },
      3,
      "",
    );
    msg.should.containEql("size is equal to the current size");
    msg.should.containEql("VCPU");
    msg.should.not.containEql("PROCESSING_UNITS");
  });

  it("should suggest scaling when VCPU suggestion is not equal to current", () => {
    const msg = getScaleSuggestionMessage(
      { units: "VCPU", currentSize: 3, minSize: 2, maxSize: 8 },
      5,
      "",
    );
    msg.should.containEql("suggesting to scale");
    msg.should.containEql("VCPU");
    msg.should.not.containEql("PROCESSING_UNITS");
  });

  it("should indicate scaling is not possible if VCPU suggestion is above max", () => {
    const msg = getScaleSuggestionMessage(
      { units: "VCPU", currentSize: 3, minSize: 2, maxSize: 8 },
      9,
      "",
    );
    msg.should.containEql("higher than MAX");
    msg.should.containEql("VCPU");
    msg.should.not.containEql("PROCESSING_UNITS");
  });

  it("should indicate scaling is not possible if VCPU suggestion is below min", () => {
    const msg = getScaleSuggestionMessage(
      { units: "VCPU", currentSize: 3, minSize: 2, maxSize: 8 },
      1,
      "",
    );
    msg.should.containEql("lower than MIN");
    msg.should.containEql("VCPU");
    msg.should.not.containEql("PROCESSING_UNITS");
  });
});

/**
 * @return {AutoscalerCloudSQL} a test CloudSQL config
 */
function getCloudSQLJSON() {
  const cloudsql = {
    units: "VCPU",
    minSize: 1,
    metrics: [
      { name: "cpu", threshold: 65, value: 95 },
    ],
  };
  return /** @type {AutoscalerCloudSQL} */ (cloudsql);
}

/**
 * @type {function (
 *    AutoscalerCloudSQL,
 *    function(AutoscalerCloudSQL,CloudSQLMetricValue): number) : number }
 */
const loopThroughCloudSQLMetrics = app.__get__("loopThroughCloudSQLMetrics");
describe("#loopThroughCloudSQLMetrics", () => {
  it("should add a default margin to each metric", () => {
    const cloudsql = getCloudSQLJSON();

    loopThroughCloudSQLMetrics(cloudsql, sinon.stub().returns(1));
    cloudsql.metrics[0].should.have.property("margin");
  });

  it("should not overwrite an existing margin", () => {
    const cloudsql = getCloudSQLJSON();

    /** @type {CloudSQLMetric} */ (cloudsql.metrics[0]).margin = 99;

    loopThroughCloudSQLMetrics(cloudsql, sinon.stub().returns(1));
    cloudsql.metrics[0].should.have.property("margin").and.equal(99);
  });
});
