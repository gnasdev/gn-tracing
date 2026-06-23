# Requirements Document

## Introduction

GN Tracing is a Manifest V3 Chrome extension with two adjacent TypeScript sub-projects (a Vite-based standalone replay player and a Cloudflare Worker OAuth proxy). The repository currently has linting, type-checking, bundling, and a release pipeline, but no test framework. This feature establishes a unified, low-friction testing setup across all three contexts.

The setup standardizes on Vitest as the single test runner, with each context using an environment-appropriate runtime (node, jsdom, or the Cloudflare Workers pool) deriving from a shared base configuration. It introduces co-located test conventions, a shared in-memory Chrome API mock with per-test reset, property-based testing with fast-check for correctness-sensitive pure modules, V8 coverage with a ratcheting floor, and integration of tests into the Taskfile, the Husky pre-commit hook, and a new GitHub Actions CI workflow.

These requirements are derived from the approved design document and provide the traceability targets for the design's nine numbered Correctness Properties.

## Glossary

- **Test_Runner**: The Vitest test runner used uniformly across all three contexts.
- **Shared_Config**: The shared base Vitest configuration (`vitest.shared.ts`) that defines coverage settings, reporters, globals, and include/exclude globs.
- **Context**: One of the three TypeScript projects in the repository: the root extension (`node` environment), the standalone player (`jsdom` environment), or the worker (Cloudflare Workers pool).
- **Chrome_Mock**: The shared in-memory stub of the `chrome.*` extension APIs defined in `test/mocks/chrome.ts`.
- **Mock_Storage_Area**: The in-memory `chrome.storage` area implementation backing the Chrome_Mock, supporting `get`, `set`, `remove`, and `clear`.
- **Coverage_Reporter**: The V8-based coverage provider configured in the Shared_Config.
- **Coverage_Threshold**: The configured minimum coverage floor (lines, functions, branches, statements) enforced during a coverage run.
- **Aggregate_Task**: The Taskfile target (`task test:all`) that runs tests across all three contexts and aggregates the result.
- **Pre_Commit_Hook**: The Husky `pre-commit` hook that runs tests related to staged files.
- **CI_Workflow**: The GitHub Actions workflow (`.github/workflows/test.yml`) that runs type-checking and tests with coverage on push and pull request.
- **Property_Suite**: The set of fast-check property-based tests that enforce the design's correctness properties.
- **Redaction_Module**: The pure privacy/redaction logic in `src/shared/privacy-redaction.ts`.
- **Target_Validator**: The pure recording-target validation logic in `src/shared/recording-target.ts` (`getRecordingTabTarget`).
- **Selector_Normalizer**: The pure selector normalization logic (`normalizeMaskDomSelectors`).
- **Zip_Parser**: The player's ZIP central-directory parser.

## Requirements

### Requirement 1: Unified Test Runner Across Contexts

**User Story:** As a developer, I want a single test runner configured for every context, so that I have one consistent mental model and tooling story across the monorepo.

#### Acceptance Criteria

1. THE Test_Runner SHALL be the only test runner configured for the root extension Context, the standalone player Context, and the worker Context, such that each of the three Contexts has exactly one Test_Runner configuration present.
2. WHEN tests run in the root extension Context, THE Test_Runner SHALL execute them in a `node` environment.
3. WHEN tests run in the standalone player Context, THE Test_Runner SHALL execute them in a `jsdom` environment.
4. WHEN tests run in the worker Context, THE Test_Runner SHALL execute them in the Cloudflare Workers pool runtime.
5. WHERE a Context defines its Test_Runner configuration, THE configuration SHALL derive its coverage settings, reporters, globals flag, and test include/exclude globs from the Shared_Config, declaring locally only the environment or pool that distinguishes the Context.
6. IF a Context is invoked for a test run but no Test_Runner configuration resolves for that Context, THEN THE Test_Runner SHALL terminate the run for that Context with a non-zero exit code and an error indicating that the Test_Runner configuration is missing, without executing any tests for that Context.

### Requirement 2: Shared Base Configuration

**User Story:** As a developer, I want coverage, reporters, globals, and file globs defined once, so that the three context configurations stay aligned and do not drift.

#### Acceptance Criteria

1. THE Shared_Config SHALL define, in a single file, the V8 coverage provider, the coverage reporters, and the Coverage_Threshold values for lines, functions, branches, and statements.
2. THE Shared_Config SHALL define exactly one canonical test file include glob and the shared exclude globs that apply to every Context.
3. WHEN a per-context configuration is created, THE per-context configuration SHALL inherit every Shared_Config setting and SHALL declare no keys other than its `environment` value or its worker pool selection.
4. IF a per-context configuration redefines a Shared_Config-owned setting (coverage provider, coverage reporters, Coverage_Threshold values, the test include glob, or the test exclude globs), THEN THE per-context configuration SHALL retain the Shared_Config value for that setting so that the resolved configuration matches the Shared_Config. This applies EXCEPT to the worker Context's coverage provider (see Requirement 6.1). The per-context `coverage.exclude` scope is NOT a Shared_Config-owned setting: each sibling Context (player, worker) MAY re-scope `coverage.exclude` to drop its own directory from the shared cross-context exclude list so it measures its own source, while still inheriting every other coverage setting.
5. THE Shared_Config SHALL exclude the `node_modules`, `dist`, and `.wrangler` directories from test discovery.

### Requirement 3: Test Conventions and Structure

**User Story:** As a developer, I want a predictable test file convention, so that tests are easy to find and stay isolated per context.

#### Acceptance Criteria

1. THE testing setup SHALL co-locate each unit test file in the same directory as the source file it covers, naming it `<name>.test.ts` for a source file named `<name>.ts`.
2. THE testing setup SHALL place shared test helpers, defined as helper modules imported by more than one test file, under a top-level `test/` directory within the owning Context.
3. THE testing setup SHALL NOT place test helper files under a Context's `src/` directory.
4. THE testing setup SHALL restrict each test file to importing only modules within its own Context, and SHALL NOT allow a test file to import source files or test helper files belonging to another Context.

### Requirement 4: Shared Chrome Extension API Mock

**User Story:** As a developer, I want a controllable in-memory Chrome API mock that resets between tests, so that I can test Chrome-dependent orchestration deterministically and in isolation.

#### Acceptance Criteria

1. THE Chrome_Mock SHALL provide stubs for the `storage.session`, `storage.local`, `runtime`, `tabs`, `alarms`, `debugger`, and `action` namespaces used by the extension.
2. WHEN `createChromeMock` is called, THE Chrome_Mock SHALL return a fresh instance with empty in-memory storage areas and spy functions that have zero recorded calls.
3. WHEN `installChromeMock` is called, THE Chrome_Mock SHALL assign the mock instance to `globalThis.chrome`.
4. WHEN a spy function on the Chrome_Mock is invoked, THE Chrome_Mock SHALL record the arguments passed to that invocation, increment that spy's recorded call count, and preserve the relative order of invocations across spies so that orchestration behavior can be asserted.
5. WHEN a value is stored via `Mock_Storage_Area.set` and subsequently read via `Mock_Storage_Area.get` with the same key, THE Mock_Storage_Area SHALL resolve the stored key-value pair.
6. WHEN a key is removed via `Mock_Storage_Area.remove`, THE Mock_Storage_Area SHALL resolve a result that does not contain that key on subsequent reads.
7. WHEN `Mock_Storage_Area.clear` is called, THE Mock_Storage_Area SHALL resolve a result that contains no keys for all subsequent reads.
8. WHEN `Mock_Storage_Area.get` is called for a key that was never set, THE Mock_Storage_Area SHALL resolve a result that does not contain that key.
9. BEFORE each test runs, THE testing setup SHALL install a fresh Chrome_Mock so that no test observes call records or storage state created by another test.
10. AFTER each test completes, THE testing setup SHALL reset the Chrome_Mock so that every in-memory storage area contains no keys and every spy's recorded call count is zero.
11. IF a module under test accesses a `chrome.*` namespace that is not present in the Chrome_Mock, THEN THE Chrome_Mock SHALL throw an error whose message names the missing namespace path.

### Requirement 5: Property-Based Testing of Correctness-Sensitive Modules

**User Story:** As a developer, I want property-based tests over pure correctness-sensitive logic, so that privacy, validation, and parsing invariants hold across a wide range of inputs.

#### Acceptance Criteria

1. THE Property_Suite SHALL use fast-check as the property-based testing library.
2. WHERE a header rule is enabled in the active privacy settings, THE Redaction_Module SHALL produce output in which, for that key, no header value is an exact case-sensitive string match to the original sensitive value.
3. WHEN `redact` is applied to already-redacted output, THE Redaction_Module SHALL produce a result that is deeply equal to the single-application result.
4. WHEN `redactJsonValue` transforms a JSON value, THE Redaction_Module SHALL preserve the complete key set and the nesting structure of the input at every level, changing only leaf values.
5. THE Redaction_Module SHALL enable, under the `strict` profile, every redaction rule that is enabled under the `standard` profile, such that the set of rules enabled under `strict` is a superset of the set enabled under `standard`.
6. WHEN `getRecordingTabTarget` is called with a tab-like input, THE Target_Validator SHALL return a result in which exactly one of `url` or `error` is non-null and the other field is null.
7. WHERE the Target_Validator returns a non-null `url`, THE Target_Validator SHALL guarantee the URL protocol is one of `http:`, `https:`, or `file:` and the host is not a Chrome Web Store host.
8. WHEN `normalizeMaskDomSelectors` is applied to its own output, THE Selector_Normalizer SHALL produce a result that is deeply equal to the single-application result.
9. WHEN the Zip_Parser parses a byte buffer that is empty, truncated, or malformed, THE Zip_Parser SHALL return a typed error value rather than throwing an exception, and SHALL NOT throw an uncaught exception for any byte buffer input.
10. THE Property_Suite SHALL run each property-based test against a minimum of 100 distinct generated input cases per run.
11. IF a property-based test fails, THEN THE Property_Suite SHALL report the shrunk counterexample identifying the failing input and the reproduction seed.
12. WHEN a property-based test is re-run with a previously reported reproduction seed, THE Property_Suite SHALL regenerate the identical input sequence produced by the original run.

### Requirement 6: Coverage Reporting and Thresholds

**User Story:** As a maintainer, I want coverage measured and enforced with a ratcheting floor, so that test quality is visible and does not regress.

#### Acceptance Criteria

1. THE Coverage_Reporter SHALL use the V8 coverage provider, EXCEPT in the worker Context, WHERE the Cloudflare Workers pool runs tests in the `workerd` runtime (which lacks `node:inspector` and cannot run V8 coverage); in that Context THE Coverage_Reporter SHALL use the Istanbul coverage provider. This is the only Shared_Config coverage setting the worker Context overrides.
2. WHEN a coverage run completes, THE Coverage_Reporter SHALL emit text, HTML, and lcov coverage reports.
3. WHEN a coverage run completes with measured coverage greater than or equal to every Coverage_Threshold metric (lines, functions, branches, and statements), THE Test_Runner SHALL exit with a zero exit code.
4. IF a coverage run completes with measured coverage below any Coverage_Threshold metric (lines, functions, branches, or statements), THEN THE Test_Runner SHALL exit with a non-zero exit code and SHALL indicate which metric fell below its threshold.
5. THE Coverage_Threshold SHALL be initialized to 60% lines, 60% functions, 55% branches, and 60% statements.
6. WHERE a Coverage_Threshold metric is changed after initialization, THE Coverage_Threshold for that metric SHALL NOT be set below its previously established value.

### Requirement 7: Test Script and Taskfile Integration

**User Story:** As a developer, I want named scripts and Taskfile targets to run tests, so that I can run single-shot or aggregate test runs predictably in local and automated environments.

#### Acceptance Criteria

1. WHEN the root `package.json` `test` script is invoked, THE Test_Runner SHALL run the root extension Context tests exactly once and exit without entering watch mode.
2. THE root `package.json` SHALL define a watch script and a coverage script under distinct names, WHERE invoking the watch script keeps the Test_Runner running and re-executes tests on file changes, and WHERE invoking the coverage script runs the tests once and produces a coverage report.
3. WHEN `task test` is invoked, THE Aggregate_Task SHALL run the root extension Context tests and SHALL exit with the exit code returned by that Context's test run.
4. WHEN `task test:all` is invoked, THE Aggregate_Task SHALL run the root extension Context, the standalone player Context, and the worker Context tests, and SHALL propagate a non-zero exit code if any Context's test run returned a non-zero exit code.
5. WHILE `task test:all` is running and an earlier Context's test run has returned a non-zero exit code, THE Aggregate_Task SHALL continue to attempt every remaining Context.
6. THE Aggregate_Task SHALL return a zero exit code if and only if every Context's test run returned a zero exit code, and SHALL return a non-zero exit code if and only if at least one Context's test run returned a non-zero exit code.
7. IF a Context's test run cannot be started, THEN THE Aggregate_Task SHALL treat that Context as failed, continue attempting the remaining Contexts, and return a non-zero exit code.
8. WHEN `task test:all` completes with at least one failed Context, THE Aggregate_Task SHALL output an indication identifying each Context whose test run failed.

### Requirement 8: Pre-Commit Hook Integration

**User Story:** As a developer, I want fast test feedback before committing, so that I catch failures related to my changes without running the full suite.

#### Acceptance Criteria

1. WHEN a commit is initiated, THE Pre_Commit_Hook SHALL run only the tests related to the staged files in single-run mode without entering watch mode or requiring interactive input.
2. WHEN no staged file has a related test, THE Pre_Commit_Hook SHALL allow the commit to proceed without running the Test_Runner.
3. IF the Pre_Commit_Hook test run exits with a non-zero code, THEN THE Pre_Commit_Hook SHALL block the commit and SHALL preserve the staged changes unmodified.
4. WHEN the Pre_Commit_Hook test run exits with a zero code, THE Pre_Commit_Hook SHALL allow the commit to proceed.
5. IF the Test_Runner cannot be executed for the staged files, THEN THE Pre_Commit_Hook SHALL block the commit and SHALL emit an error message identifying the execution failure.

### Requirement 9: Continuous Integration Workflow

**User Story:** As a maintainer, I want tests to run automatically on push and pull request, so that regressions are caught before merge.

#### Acceptance Criteria

1. WHEN a push event occurs or a pull request event occurs, THE CI_Workflow SHALL start a job run.
2. BEFORE running tests, THE CI_Workflow SHALL install dependencies for the root extension Context, the standalone player Context, and the worker Context.
3. IF dependency installation fails for the root extension Context, the standalone player Context, or the worker Context, THEN THE CI_Workflow SHALL report a failure status, skip all downstream type-checking and test steps, and complete with a non-zero status.
4. WHEN dependency installation completes successfully for the root extension Context, the standalone player Context, and the worker Context, THE CI_Workflow SHALL run type-checking for the root extension Context, the standalone player Context, and the worker Context.
5. WHEN type-checking completes successfully for the root extension Context, the standalone player Context, and the worker Context, THE CI_Workflow SHALL run the test suite with coverage for the root extension Context, the standalone player Context, and the worker Context.
6. IF type-checking fails, the test run fails, or measured coverage falls below the Coverage_Threshold for the root extension Context, the standalone player Context, or the worker Context, THEN THE CI_Workflow SHALL mark the job as failed and complete with a non-zero status.
