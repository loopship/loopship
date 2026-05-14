#!/usr/bin/env bun

import {
  lifecycleMatrixMarkdown,
  runLifecycleMatrix,
  summarizeLifecycleMatrix,
} from "./lifecycle_matrix.ts";

const results = runLifecycleMatrix();
const summary = summarizeLifecycleMatrix(results);

process.stdout.write(lifecycleMatrixMarkdown(results));

if (summary.passed !== summary.total) {
  process.exitCode = 1;
}
