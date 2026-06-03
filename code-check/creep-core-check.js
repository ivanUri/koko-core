#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const VELORA_PATH = process.env.VELORA_PATH || path.join(__dirname, '..', 'main');

async function runCreepCoreCheck() {
    console.log('Starting Creep Core Check...\n');
    console.log('Using Velora binary:', VELORA_PATH);
    
    const browser = await chromium.launch({
        headless: false,
        executablePath: VELORA_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    });

    try {
        const page = await browser.newPage();
        
        // Track console messages and errors
        const consoleMessages = [];
        const errors = [];
        
        page.on('console', (msg) => {
            const text = msg.text();
            consoleMessages.push({
                type: msg.type(),
                text: text,
                location: msg.location(),
            });
            
            if (msg.type() === 'error') {
                console.error('❌ Browser Error:', text);
                errors.push(text);
            } else if (msg.type() === 'warning') {
                console.warn('⚠️  Warning:', text);
            }
        });

        page.on('pageerror', (error) => {
            console.error('❌ Page Error:', error.message);
            errors.push(`Page Error: ${error.message}`);
        });

        // Create a test HTML page with creep-core.js
        const creepCoreJs = fs.readFileSync(
            path.join(__dirname, 'creep-core.js'),
            'utf8'
        );

        const testHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Creep Core Check</title>
    <style>
        body {
            font-family: monospace;
            padding: 20px;
            background: #1e1e1e;
            color: #d4d4d4;
        }
        .test-section {
            margin: 20px 0;
            padding: 15px;
            background: #252526;
            border-left: 3px solid #007acc;
        }
        .pass { color: #4ec9b0; }
        .fail { color: #f48771; }
        .warn { color: #dcdcaa; }
        h2 { color: #569cd6; }
        pre { 
            background: #1e1e1e;
            padding: 10px;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <h1>🔍 Creep Core Fingerprinting Check</h1>
    <div id="results"></div>
    
    <script>
        // Inject creep-core.js
        ${creepCoreJs}
        
        // Run tests
        const results = document.getElementById('results');
        
        function addResult(title, status, details) {
            const section = document.createElement('div');
            section.className = 'test-section';
            section.innerHTML = \`
                <h2>\${title}</h2>
                <div class="\${status}">\${status.toUpperCase()}</div>
                <pre>\${details}</pre>
            \`;
            results.appendChild(section);
        }
        
        async function runTests() {
            console.log('Starting fingerprinting tests...');
            
            // Test 1: Canvas
            try {
                const canvas = await getCanvas2d();
                addResult(
                    'Canvas 2D', 
                    canvas ? 'pass' : 'fail',
                    canvas ? JSON.stringify(canvas, null, 2) : 'Failed to get canvas data'
                );
            } catch (e) {
                addResult('Canvas 2D', 'fail', e.message);
                console.error('Canvas test failed:', e);
            }
            
            // Test 2: WebGL
            try {
                const webgl = await getWebgl();
                addResult(
                    'WebGL',
                    webgl ? 'pass' : 'fail',
                    webgl ? JSON.stringify(webgl, null, 2) : 'Failed to get WebGL data'
                );
            } catch (e) {
                addResult('WebGL', 'fail', e.message);
                console.error('WebGL test failed:', e);
            }
            
            // Test 3: Fonts
            try {
                const fonts = await getFonts();
                addResult(
                    'Fonts',
                    fonts ? 'pass' : 'fail',
                    fonts ? JSON.stringify(fonts, null, 2) : 'Failed to get fonts data'
                );
            } catch (e) {
                addResult('Fonts', 'fail', e.message);
                console.error('Fonts test failed:', e);
            }
            
            // Test 4: Navigator
            try {
                const workerScope = await getBestWorkerScope();
                const nav = await getNavigator(workerScope);
                addResult(
                    'Navigator',
                    nav ? 'pass' : 'fail',
                    nav ? JSON.stringify(nav, null, 2) : 'Failed to get navigator data'
                );
            } catch (e) {
                addResult('Navigator', 'fail', e.message);
                console.error('Navigator test failed:', e);
            }
            
            // Test 5: Audio
            try {
                const audio = await getOfflineAudioContext();
                addResult(
                    'Audio',
                    audio ? 'pass' : 'fail',
                    audio ? JSON.stringify(audio, null, 2) : 'Failed to get audio data'
                );
            } catch (e) {
                addResult('Audio', 'fail', e.message);
                console.error('Audio test failed:', e);
            }
            
            // Test 6: Screen
            try {
                const screen = await getScreen();
                addResult(
                    'Screen',
                    screen ? 'pass' : 'fail',
                    screen ? JSON.stringify(screen, null, 2) : 'Failed to get screen data'
                );
            } catch (e) {
                addResult('Screen', 'fail', e.message);
                console.error('Screen test failed:', e);
            }
            
            // Test 7: Voices
            try {
                const voices = await getVoices();
                addResult(
                    'Voices',
                    voices ? 'pass' : 'fail',
                    voices ? JSON.stringify(voices, null, 2) : 'Failed to get voices data'
                );
            } catch (e) {
                addResult('Voices', 'fail', e.message);
                console.error('Voices test failed:', e);
            }
            
            console.log('All tests completed!');
        }
        
        // Start tests
        runTests().catch(console.error);
    </script>
</body>
</html>
        `;

        // Write temporary HTML file
        const tempHtmlPath = path.join(__dirname, 'tmp', 'creep-core-test.html');
        fs.mkdirSync(path.dirname(tempHtmlPath), { recursive: true });
        fs.writeFileSync(tempHtmlPath, testHtml);

        console.log('Loading test page...');
        await page.goto(`file://${tempHtmlPath}`, {
            waitUntil: 'networkidle0',
            timeout: 30000,
        });

        // Wait for tests to complete (give it time to run)
        await page.waitForTimeout(15000);

        // Get test results
        const testResults = await page.evaluate(() => {
            const sections = document.querySelectorAll('.test-section');
            return Array.from(sections).map(section => ({
                title: section.querySelector('h2').textContent,
                status: section.querySelector('div[class*="pass"], div[class*="fail"], div[class*="warn"]').textContent,
                details: section.querySelector('pre').textContent,
            }));
        });

        console.log('\n' + '='.repeat(80));
        console.log('TEST RESULTS SUMMARY');
        console.log('='.repeat(80) + '\n');

        testResults.forEach(result => {
            const icon = result.status.includes('PASS') ? '✅' : 
                        result.status.includes('WARN') ? '⚠️' : '❌';
            console.log(`${icon} ${result.title}: ${result.status}`);
            if (result.status.includes('FAIL')) {
                console.log(`   Details: ${result.details.substring(0, 100)}...`);
            }
        });

        // Summary
        const passed = testResults.filter(r => r.status.includes('PASS')).length;
        const failed = testResults.filter(r => r.status.includes('FAIL')).length;
        const total = testResults.length;

        console.log('\n' + '='.repeat(80));
        console.log(`Summary: ${passed}/${total} tests passed, ${failed}/${total} tests failed`);
        console.log('='.repeat(80) + '\n');

        if (errors.length > 0) {
            console.log('\n⚠️  Errors encountered:');
            errors.forEach((error, i) => {
                console.log(`${i + 1}. ${error}`);
            });
        }

        // Save detailed results
        const resultData = {
            summary: {
                total,
                passed,
                failed,
                timestamp: new Date().toISOString(),
            },
            tests: testResults,
            consoleMessages: consoleMessages.filter(m => m.type === 'error' || m.type === 'warning'),
            errors,
        };

        const resultPath = path.join(__dirname, 'tmp', 'creep-core-results.json');
        fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));
        console.log(`\nDetailed results saved to: ${resultPath}`);

    } catch (error) {
        console.error('Test execution failed:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

// Run the check
runCreepCoreCheck()
    .then(() => {
        console.log('\n✅ Creep Core check completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Creep Core check failed:', error);
        process.exit(1);
    });
