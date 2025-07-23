<br />
<p align="center">
  <h2 align="center">Autoscaler tool for CloudSQL</h2>
  <p align="center">
    <!-- In one sentence: what does the code in this directory do? -->
    Set up the Autoscaler using Terraform configuration files
    <br />
    <a href="../README.md">Home</a>
    ·
    <a href="../src/scaler/README.md">Scaler component</a>
    ·
    <a href="../src/poller/README.md">Poller component</a>
    ·
    Terraform configuration
    ·
    Monitoring
    <br />
    <a href="cloud-functions/README.md">Cloud Run functions</a>
  </p>

</p>

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Overview](#overview)
- [Monitoring](#monitoring)

## Overview

This directory contains Terraform configuration files to quickly set up the
infrastructure of your Autoscaler.

The Autoscaler can be deployed in two different ways:

- [Deployment to Cloud Run functions](cloud-functions/README.md): Autoscaler
  components are deployed to [Cloud Run functions][cloudfunctions], with
  [Pub/Sub][pubsub] used for asynchronous messaging between components. Use
  this deployment type for serverless operation, for cross-project
  Autoscaling, and to take maximal advantage of Google Cloud managed
  services.

## Monitoring

The [monitoring](modules/monitoring) module is an optional module for monitoring,
and creates the following resources.

- Cloud Monitoring Dashboard: a starter dashboard users could deploy to get
  started. This dashboard has scaling time metrics.

[cloudfunctions]: https://cloud.google.com/functions
[pubsub]: https://cloud.google.com/pubsub
