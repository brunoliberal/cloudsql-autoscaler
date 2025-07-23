<br />
<p align="center">
  <h2 align="center">Autoscaler tool for CloudSQL</h2>
  <p align="center">
    <!-- In one sentence: what does the code in this directory do? -->
    Retrieve metrics for one or more CloudSQL Instances
    <br />
    <a href="../../README.md">Home</a>
    ·
    Poller component
    ·
    <a href="../scaler/README.md">Scaler component</a>
    ·
    <a href="../../terraform/README.md">Terraform configuration</a>
    ·
    <a href="../../terraform/README.md#Monitoring">Monitoring</a>
  </p>
</p>

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Overview](#overview)
- [Configuration parameters](#configuration-parameters)
  - [Required](#required)
  - [Required for a Cloud Run functions deployment](#required-for-a-cloud-run-functions-deployment)
  - [Optional](#optional)
- [Metrics parameters](#metrics-parameters)
  - [Selectors](#selectors)
  - [Parameters](#parameters)
- [Custom metrics, thresholds and margins](#custom-metrics-thresholds-and-margins)
  - [Thresholds](#thresholds)
  - [Margins](#margins)
  - [Metrics](#metrics)
- [State Database](#state-database)
- [Example configuration for Cloud Run functions](#example-configuration-for-cloud-run-functions)

## Overview

The Poller component takes an array of CloudSQL instances and obtains load
metrics for each of them from [Cloud Monitoring][cloud-monitoring]. This array
may come from the payload of a Cloud PubSub message.

Then for each CloudSQL instance it publishes a message via the specified Cloud
PubSub topic or via HTTP, which includes the metrics and part of the
configuration for the CloudSQL instance.

The Scaler component will receive the message, compare the metric values with
the recommended thresholds, plus or minus an [allowed
margin](#margins), and if any of the values fall outside of this range, the
Scaler component will adjust the number of nodes in the CloudSQL instance
accordingly. Note that the thresholds are different depending f a CloudSQL instance is
[zonal or regional][cloudsql-locations].

## Configuration parameters

The following are the configuration parameters consumed by the Poller component.
Some of these parameters are forwarded to the Scaler component as well.

In the case of the Poller and Scaler components deployed to Cloud Run functions,
the parameters are defined using JSON in the payload of the PubSub message that
is published by the Cloud Scheduler job.

See the [configuration section][autoscaler-home-config] in the home page for
instructions on how to change the payload.

The Autoscaler JSON (for Cloud Run functions) or YAML (for GKE) configuration
can be validated by running the command:

```shell
npm install
npm run validate-config-file -- path/to/config_file
```

### Required

| Key          | Description                                                   |
| ------------ | ------------------------------------------------------------- |
| `projectId`  | Project ID of the CloudSQL to be monitored by the Autoscaler  |
| `instanceId` | Instance ID of the CloudSQL to be monitored by the Autoscaler |

### Required for a Cloud Run functions deployment

| Key                 | Description                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scalerPubSubTopic` | PubSub topic for the Poller function to publish messages for the Scaler function. The topic must be in the format `projects/{projects}/topics/{topicId}`. |

### Optional

| Key                      | Default Value   | Description                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units`                  | `VCPU`          | Specifies the units that capacity will be measured. CloudSQL only supports VCPU                                                                                                                                                                                                          |
| `minSize`                | 2 VCPUs         | Minimum number of CloudSQL VCPUs units that the instance can be scaled IN to.　Do not include the unit in the value.                                                                                                                                                                     |
| `maxSize`                | 4 VCPUs         | Maximum number of CloudSQL nodes or processing units that the instance can be scaled OUT to.　Do not include the unit in the value.                                                                                                                                                      |
| `scalingMethod`          | `FIXED`         | Scaling method that should be used. Options are: `FIXED`, `DIRECT`. See the [scaling methods section][autoscaler-scaler-methods] in the Scaler component page for more information.                                                                                                      |
| `overloadStepSize`       | 2               | Number of steps to skip (machine-type) when selecting a vCPU for the CloudSQL instance when is overloaded, and the `FIXED` method is used.　Do not include the unit in the value.                                                                                                        |
| `scaleOutCoolingMinutes` | 5               | Minutes to wait after scaling IN or OUT before a scale OUT event can be processed.                                                                                                                                                                                                       |
| `scaleInCoolingMinutes`  | 5               | Minutes to wait after scaling IN or OUT before a scale IN event can be processed.                                                                                                                                                                                                        |
| `overloadCoolingMinutes` | 5               | Minutes to wait after scaling IN or OUT before a scale OUT event can be processed, when the CloudSQL instance is overloaded. An instance is overloaded if its High Priority CPU utilization is over 90%.                                                                                 |
| `stateProjectId`         | `${projectId}`  | The project ID where the Autoscaler state will be persisted. By default it is persisted using [Cloud Firestore][cloud-firestore] in the same project as the CloudSQL instance.                                                                                                           |
| `stateDatabase`          | Object          | An Object that can override the database for managing the state of the Autoscaler. The default database is Firestore. Refer to the [state database](#state-database) for details.                                                                                                        |
| `metrics`                | Array           | Array of objects that can override the values in the metrics used to decide when the CloudSQL instance should be scaled IN or OUT. Refer to the [metrics definition table](#metrics-parameters) to see the fields used for defining metrics.                                             |
| `scaleInLimit`           | `undefined`     | Percentage (integer) of the total instance size that can be removed in a scale in event when using the linear algorithm. For example if set to `20`, only 20% of the instance size can be removed in a single scaling event, when `scaleInLimit` is `undefined` a limit is not enforced. |
| `downstreamPubSubTopic`  | `undefined`     | Set this parameter to `projects/${projectId}/topics/downstream-topic` if you want the the Autoscaler to publish events that can be consumed by downstream applications. See [Downstream messaging](../scaler/README.md#downstream-messaging) for more information.                       |
| `scalerURL`              | `http://scaler` | URL where the scaler service receives HTTP requests.                                                                                                                                                                                                                                     |

## Metrics parameters

The table describes the objects used to define metrics. These can be provided
in the configuration objects to customize the metrics used to autoscale your
CloudSQL instances.

To specify a custom threshold specify the name of the metrics to customize
followed by the parameter values you wish to change. The updated parameters
will be merged with the default metric parameters.

### Selectors

| Key    | Description                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | A unique name of the for the metric to be evaulated. If you want to override the default metrics, their names are: `cpu`. |

### Parameters

When defining a metric for the Autoscaler there are two key components:
thresholds and a [Cloud Monitoring time series metric][time-series-filter]
comprised of a filter, reducer, aligner and period. Having a properly defined
metric is critical to the opertional of the Autoscaler, please refer to
[Filtering and aggregation: manipulating time series][filtering-and-aggregation]
for a complete discussion on building metric filters and aggregating data
points.

| Key                        | Default      | Description                                                                                                                                                                                                                  |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filter`                   |              | The [CloudSQL metric] and [filter][time-series-filter] that should be used when querying for data. The Autoscaler will automatically add the filter expressions for CloudSQL instance resources, instance id and project id. |
| `reducer`                  | `REDUCE_SUM` | The reducer specifies how the data points should be aggregated when querying for metrics, typically `REDUCE_SUM`. For more details please refer to [Alert Policies - Reducer][alertpolicy-reducer] documentation.            |
| `aligner`                  | `ALIGN_MAX`  | The aligner specifies how the data points should be aligned in the time series, typically `ALIGN_MAX`. For more details please refer to [Alert Policies - Aligner][alertpolicy-aligner] documentation.                       |
| `period`                   | 60           | Defines the period of time in units of seconds at which aggregation takes place. Typically the period should be 60.                                                                                                          |
| `regional_threshold`       |              | Threshold used to evaluate if a regional instance needs to be scaled in or out.                                                                                                                                              |
| `multi_regional_threshold` |              | Threshold used to evaluate if a multi-regional instance needs to be scaled in or out.                                                                                                                                        |
| `regional_margin`          | 5            | Margin above and below the threshold where the metric value is allowed. If the metric falls outside of the range `[threshold - margin, threshold + margin]`, then the regional instance needs to be scaled in or out.        |
| `multi_regional_margin`    | 5            | Margin above and below the threshold where the metric value is allowed. If the metric falls outside of the range `[threshold - margin, threshold + margin]`, then the multi regional instance needs to be scaled in or out.  |

## Custom metrics, thresholds and margins

The Autoscaler determines the number of nodes or processing units to be added
or substracted to an instance based on the recommended thresholds for CPU metrics.

It is recommended using the provided metrics, thresholds and margins unchanged. However,
in some cases you may want to modify these or use a custom metric,
for example: if reaching the default upper limit triggers an alert to your operations
team, you could make the Autoscaler react to a more conservative threshold to
avoid alerts being triggered.

### Thresholds

To modify the recommended thresholds, add the metrics parameter to your
configuration and specify name (`cpu`) of the metric to be changed and desired `regional_threshold` or
`multi_regional_threshold` for your CloudSQL instance.

### Margins

A margin defines an upper and a lower limit around the threshold. An autoscaling
event will be triggered only if the metric value falls above the upper limit,
or below the lower limit.

The objective of this parameter is to avoid autoscaling events being triggered
for small workload fluctuations around the threshold, thus creating a smoothing
effect in autoscaler actions. The threshold and metric
together define a range `[threshold - margin, threshold + margin]`, where the
metric value is allowed. The smaller the margin, the narrower the range,
resulting in higher probability that an autoscaling event is triggered.

By default, the margin value is `5` for both regional and multi-regional instances.
You can change the default value by specifying `regional_margin`
or `multi_regional_margin` in the metric parameters. Specifying a margin parameter
for a metric is optional.

### Metrics

To create a custom metric, add the metrics parameter to your
configuration specifying the required fields (`name`, `filter`,
`regional_threshold`, `multi_regional_threshold`). The `period`,
`reducer` and `aligner` are defaulted but can also be specified in
the metric definition.

The CloudSQL documentation contains details for the [CloudSQL
metric][cloudsql-metrics] and [filter][time-series-filter] that should be used
when querying for data. The Autoscaler will automatically add the filter
expressions for [CloudSQL instance resources, instance id][cloudsql-filter] and
project id, unless you have chosen a name for your custom metric that matches
one of the default metrics, in which case you may either:

1.  Choose a different name for your custom metric (recommended), or
2.  Construct the full filter expression manually to include the [CloudSQL
    details][cloudsql-filter] and project id.

## State Database

The table describes the objects used to specify the database
for managing the state of the Autoscaler.

| Key    | Default     | Description                                                                                                                                   |
| ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | `firestore` | Name of the database for managing the state of the Autoscaler. By default, Firestore is used. The currently supported values are `firestore`. |

## Example configuration for Cloud Run functions

```json
[
  {
    "projectId": "basic-configuration",
    "instanceId": "another-cloudsql1",
    "scalerPubSubTopic": "projects/my-cloudsql-project/topics/cloudsql-scaling",
    "units": "VCPUs",
    "minSize": 5,
    "maxSize": 30,
    "scalingMethod": "DIRECT"
  },
  {
    "projectId": "custom-threshold",
    "instanceId": "cloudsql1",
    "scalerPubSubTopic": "projects/my-cloudsql-project/topics/cloudsql-scaling",
    "units": "VCPU",
    "minSize": 2,
    "maxSize": 16,
    "metrics": [
      {
        "name": "cpu",
        "regional_threshold": 40,
        "regional_margin": 3
      }
    ]
  },
  {
    "projectId": "custom-metric",
    "instanceId": "another-cloudsql1",
    "scalerPubSubTopic": "projects/my-cloudsql-project/topics/cloudsql-scaling",
    "units": "VCPU",
    "minSize": 5,
    "maxSize": 30,
    "scalingMethod": "FIXED",
    "scaleInLimit": 25,
    "metrics": [
      {
        "name": "my_custom_metric",
        "filter": "metric.type=\"cloudsql.googleapis.com/instance/resource/metric\"",
        "regional_threshold": 40,
        "multi_regional_threshold": 30
      }
    ]
  }
]
```

<!-- LINKS: https://www.markdownguide.org/basic-syntax/#reference-style-links -->

[cloud-monitoring]: https://cloud.google.com/monitoring
[autoscaler-home-config]: ../README.md#configuration
[autoscaler-scaler-methods]: ../scaler/README.md#scaling-methods
[cloud-firestore]: https://cloud.google.com/firestore
[alertpolicy-reducer]: https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#reducer
[alertpolicy-aligner]: https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#aligner
[filtering-and-aggregation]: https://cloud.google.com/monitoring/api/v3/aggregation
[time-series-filter]: https://cloud.google.com/monitoring/api/v3/filters#time-series-filter
