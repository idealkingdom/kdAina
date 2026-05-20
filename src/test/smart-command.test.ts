import * as assert from 'assert';

/**
 * Smart Command Completion System - Integration and Unit Tests
 */
// ─── Smart Command Completion System — Unit Tests ──────────────────────
// Tests pattern matching for stall detection, interactive prompts,
// exit code inference, and negative/edge cases.
// These regexes mirror the production constants in sys-tools.ts.

suite('Smart Command Completion System Tests', () => {
    // ── Mirror of production STALL_PATTERNS ──
    const STALL_PATTERNS = [
        { pattern: /waiting for file changes/i,         type: 'watch_mode',  tool: 'vitest/jest' },
        { pattern: /press h to show help.*press q/i,    type: 'watch_mode',  tool: 'vitest' },
        { pattern: /press.*to quit/i,                   type: 'watch_mode',  tool: 'vitest/jest' },
        { pattern: /watching for file changes/i,        type: 'watch_mode',  tool: 'nodemon' },
        { pattern: /webpack.*compiled\s+(success|with)/i, type: 'watch_mode', tool: 'webpack' },
        { pattern: /watching\s+for\s+changes/i,         type: 'watch_mode',  tool: 'tsc' },
        { pattern: /\?\s*(y\/n|yes\/no)\s*:?\s*$/im,    type: 'interactive', tool: null },
        { pattern: /\(y\/N\)\s*$/im,                    type: 'confirm',     tool: 'npm' },
        { pattern: /password.*:\s*$/im,                  type: 'interactive', tool: null },
        { pattern: /enter\s+.*:\s*$/im,                 type: 'interactive', tool: null },
    ];

    // ── Mirror of production TEST_PASS/FAIL_PATTERNS ──
    const TEST_PASS_PATTERNS = [/tests?\s+\d+\s+passed/i, /\d+\s+passing/i, /all tests passed/i, /\bPASS\b\s+\S/];
    const TEST_FAIL_PATTERNS = [/tests?\s+\d+\s+failed/i, /\d+\s+failed/i, /\bFAIL\b\s/i, /failures?:\s*[1-9]/i, /AssertionError/i];

    // ── Helper: mirrors production analyzeOutput() ──
    function inferExitCode(output: string): number | null {
        const hasFail = TEST_FAIL_PATTERNS.some(p => p.test(output));
        const hasPass = TEST_PASS_PATTERNS.some(p => p.test(output));
        return hasFail ? 1 : hasPass ? 0 : null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // WATCH MODE DETECTION
    // ═══════════════════════════════════════════════════════════════════

    test('Detects Vitest watch mode output', () => {
        const output = `
            DEV  v4.1.6 /home/user/project
            ✓ src/components/Dashboard.test.jsx (1 test) 80ms
            Test Files  1 passed (1)
            Tests       1 passed (1)
            Duration    2.01s

            PASS  Waiting for file changes...
            press h to show help, press q to quit
        `;
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched, 'Should match a stall pattern');
        assert.strictEqual(matched!.type, 'watch_mode');
    });

    test('Detects Jest watch mode output', () => {
        const output = 'Waiting for file changes since 2026-05-18';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'watch_mode');
    });

    test('Detects nodemon watch mode', () => {
        const output = '[nodemon] watching for file changes before restarting';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'watch_mode');
        assert.strictEqual(matched!.tool, 'nodemon');
    });

    test('Detects webpack compiled successfully (watch)', () => {
        const output = 'webpack 5.99.9 compiled successfully in 8236 ms';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched, 'Should match webpack watch pattern');
        assert.strictEqual(matched!.type, 'watch_mode');
        assert.strictEqual(matched!.tool, 'webpack');
    });

    test('Detects webpack compiled with warnings (watch)', () => {
        const output = 'webpack 5.99.9 compiled with 2 warnings in 5000 ms';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.tool, 'webpack');
    });

    test('Detects tsc watching for changes', () => {
        const output = 'Watching for changes...';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'watch_mode');
        assert.strictEqual(matched!.tool, 'tsc');
    });

    // ═══════════════════════════════════════════════════════════════════
    // INTERACTIVE PROMPT DETECTION
    // ═══════════════════════════════════════════════════════════════════

    test('Detects y/N confirmation prompt', () => {
        const output = 'Do you want to proceed? (y/N)';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched, 'Should match confirm pattern');
        assert.strictEqual(matched!.type, 'confirm');
    });

    test('Detects y/n confirmation prompt', () => {
        const output = '? Do you want to continue? (y/n)';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        // (y/n) matches the (y/N) confirm pattern (case-insensitive)
        assert.strictEqual(matched!.type, 'confirm');
    });

    test('Detects inline yes/no interactive prompt', () => {
        const output = '? Overwrite existing files? yes/no:';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'interactive');
    });

    test('Detects password prompt', () => {
        const output = 'Enter password: ';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched, 'Should match password prompt');
        assert.strictEqual(matched!.type, 'interactive');
    });

    test('Detects generic "Enter something:" prompt', () => {
        const output = 'Enter your API key: ';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'interactive');
    });

    test('Detects sudo password prompt', () => {
        const output = '[sudo] password for user:';
        const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
        assert.ok(matched);
        assert.strictEqual(matched!.type, 'interactive');
    });

    // ═══════════════════════════════════════════════════════════════════
    // EXIT CODE INFERENCE
    // ═══════════════════════════════════════════════════════════════════

    test('Infers exitCode=0 from "Tests 2 passed"', () => {
        assert.strictEqual(inferExitCode('Tests  2 passed (2)'), 0);
    });

    test('Infers exitCode=0 from "5 passing"', () => {
        assert.strictEqual(inferExitCode('5 passing (10s)'), 0);
    });

    test('Infers exitCode=0 from "PASS path/to/test"', () => {
        assert.strictEqual(inferExitCode('PASS  src/components/Button.test.tsx'), 0);
    });

    test('Infers exitCode=1 from "Tests 1 failed"', () => {
        assert.strictEqual(inferExitCode('Tests  1 failed (1)'), 1);
    });

    test('Infers exitCode=1 from "FAIL path/to/test"', () => {
        assert.strictEqual(inferExitCode('FAIL  src/components/Button.test.tsx'), 1);
    });

    test('Infers exitCode=1 from "failures: 3"', () => {
        assert.strictEqual(inferExitCode('failures: 3'), 1);
    });

    test('Infers exitCode=null from unrecognized output', () => {
        assert.strictEqual(inferExitCode('Hello world'), null);
        assert.strictEqual(inferExitCode('Process completed'), null);
        assert.strictEqual(inferExitCode('Build finished'), null);
    });

    // ─── Critical: mixed pass/fail must infer FAILURE ───
    test('Mixed pass/fail output infers exitCode=1 (fail wins)', () => {
        const mixedOutput = `
            Tests  5 passed, 2 failed (7)
            Test Suites: 1 failed, 2 passed, 3 total
        `;
        assert.strictEqual(inferExitCode(mixedOutput), 1, 'Fail must take priority over pass');
    });

    test('Vitest mixed output infers exitCode=1', () => {
        const output = `
            ✓ src/utils.test.ts (3 tests)
            ✗ src/api.test.ts (1 test)
            Tests  3 passed, 1 failed
            FAIL  src/api.test.ts
        `;
        assert.strictEqual(inferExitCode(output), 1);
    });

    // ═══════════════════════════════════════════════════════════════════
    // NEGATIVE CASES — Should NOT match
    // ═══════════════════════════════════════════════════════════════════

    test('Normal output does NOT match stall patterns', () => {
        const normalOutputs = [
            'npm install completed successfully',
            'Build finished in 12.5s',
            'Process exited with code 0',
            'Compiling TypeScript...',
            'Bundling with esbuild',
        ];
        for (const output of normalOutputs) {
            const matched = STALL_PATTERNS.find(sp => sp.pattern.test(output));
            assert.strictEqual(matched, undefined, `Should NOT match: "${output}"`);
        }
    });

    test('PASS without context does NOT trigger pass inference', () => {
        // Bare "PASS" at end of line should NOT match the tightened regex
        const output = 'Security check: PASS';
        assert.strictEqual(inferExitCode(output), null, 'Bare PASS without test file context should not infer exit code');
    });

    test('"passed" in prose does NOT trigger pass inference', () => {
        const output = 'The data passed through the pipeline';
        assert.strictEqual(inferExitCode(output), null);
    });

    // ─── calculateDiffStats Unit Tests ───
    suite('calculateDiffStats', () => {
        const { calculateDiffStats } = require('../tools/file-tools');

        test('calculates stats for pure additions', () => {
            const original = '';
            const modified = 'line1\nline2\nline3';
            const stats = calculateDiffStats(original, modified);
            assert.strictEqual(stats.additions, 3);
            assert.strictEqual(stats.deletions, 0);
        });

        test('calculates stats for pure deletions', () => {
            const original = 'line1\nline2\nline3';
            const modified = '';
            const stats = calculateDiffStats(original, modified);
            assert.strictEqual(stats.additions, 0);
            assert.strictEqual(stats.deletions, 3);
        });

        test('calculates stats for substitutions/modifications', () => {
            const original = 'line1\nline2\nline3';
            const modified = 'line1\nlineModified\nline3\nlineAdded';
            const stats = calculateDiffStats(original, modified);
            // LCS is ['line1', 'line3'] (length 2)
            // original has 3 lines -> deletions = 3 - 2 = 1
            // modified has 4 lines -> additions = 4 - 2 = 2
            assert.strictEqual(stats.additions, 2);
            assert.strictEqual(stats.deletions, 1);
        });

        test('calculates stats for empty strings', () => {
            const stats = calculateDiffStats('', '');
            assert.strictEqual(stats.additions, 0);
            assert.strictEqual(stats.deletions, 0);
        });
    });
});
