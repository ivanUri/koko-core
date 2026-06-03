#!/usr/bin/env node
/**
 * Debug WebGL detection in Velora
 * Tests basic WebGL functionality before running CreepJS
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const VELORA_BIN = path.join(__dirname, '..', 'zig-out', 'bin', 'velora');
const TEST_HTML = path.join(__dirname, '..', 'velora-test', 'webgl-debug.html');

async function runVelora(htmlFile, timeout = 5000) {
    return new Promise((resolve, reject) => {
        // Convert to file:// URL
        const fileUrl = 'file://' + path.resolve(htmlFile);
        const velora = spawn(VELORA_BIN, [fileUrl]);
        
        let stdout = '';
        let stderr = '';
        
        velora.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        velora.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        const timer = setTimeout(() => {
            velora.kill();
            resolve({ stdout, stderr, timeout: true });
        }, timeout);
        
        velora.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code, timeout: false });
        });
        
        velora.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function main() {
    console.log('=== WebGL Debug Test ===\n');
    
    if (!fs.existsSync(VELORA_BIN)) {
        console.error('ERROR: Velora binary not found at', VELORA_BIN);
        console.error('Run: zig build');
        process.exit(1);
    }
    
    if (!fs.existsSync(TEST_HTML)) {
        console.error('ERROR: Test HTML not found at', TEST_HTML);
        process.exit(1);
    }
    
    console.log('Running Velora with', TEST_HTML);
    console.log('Waiting 5 seconds for execution...\n');
    
    const result = await runVelora(TEST_HTML, 5000);
    
    console.log('--- STDOUT ---');
    console.log(result.stdout || '(empty)');
    
    console.log('\n--- STDERR ---');
    console.log(result.stderr || '(empty)');
    
    console.log('\n--- RESULT ---');
    if (result.timeout) {
        console.log('Process timed out (5s) - this is normal for headless');
    } else {
        console.log('Exit code:', result.code);
    }
    
    // Look for specific patterns
    console.log('\n--- ANALYSIS ---');
    const combined = result.stdout + result.stderr;
    
    if (combined.includes('getContext("webgl"): OK')) {
        console.log('✅ WebGL context creation successful');
    } else if (combined.includes('getContext("webgl"): NULL')) {
        console.log('❌ WebGL context is NULL');
    } else {
        console.log('⚠️  No WebGL context test output found');
    }
    
    if (combined.includes('VENDOR:')) {
        console.log('✅ getParameter(VENDOR) works');
    } else if (combined.includes('VENDOR error:')) {
        console.log('❌ getParameter(VENDOR) failed');
    }
    
    if (combined.includes('readPixels: OK')) {
        console.log('✅ readPixels works');
    } else if (combined.includes('readPixels error:')) {
        console.log('❌ readPixels failed');
    }
    
    if (combined.includes('Extensions:')) {
        console.log('✅ getSupportedExtensions works');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
