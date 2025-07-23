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
const rewire = require("rewire");
require("should");
const { createCloudSQLParameters } = require("../test-utils.js");

const app = rewire("../../scaling-methods/direct.js");

const calculateSize = app.__get__("calculateSize");
describe("#direct.calculateSize", () => {
  it("should return the maximum processing units size", () => {
    const cloudsql = createCloudSQLParameters({ maxSize: 5000 });

    calculateSize(cloudsql).should.equal(5000);
  });

  it("should return the maximum nodes size", () => {
    const cloudsql = createCloudSQLParameters({ units: "NODES", maxSize: 8 });

    calculateSize(cloudsql).should.equal(8);
  });
});
