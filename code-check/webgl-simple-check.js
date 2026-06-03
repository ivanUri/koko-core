#!/usr/bin/env node
/**
 * Simple WebGL check using CDP
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const VELORA_BIN = path.join(__dirname, '..', 'zig-out', 'bin', 'velora');
const TEST_HTML = path.join(__dirname, '..', 'velora-test', 'webgl-debug.html');

// Start a simple HTTP server
function startServer(port) {
    const server = http.createServer((req, res) => {
        if (req.url === '/test.html') {
            const html = fs.readFileSync(TEST_HTML, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });
    
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            console.log(`HTTP server listening on http://127.0.0.1:${port}`);
            resolve(server);
        });
    });
}

async function runTest() {
    const HTTP_PORT = 9876;
    const CDP_PORT = 9877;
    
    console.log('=== WebGL Simple Check ===\n');
    
    // Start HTTP server
    const server = await startServer(HTTP_PORT);
    
    try {
        // Start Velora with CDP
        console.log(`Starting Velora with CDP on port ${CDP_PORT}...`);
        const velora = spawn(VELORA_BIN, [
            'serve',
            '--port', CDP_PORT.toString(),
            '--host', '127.0.0.1'
        ]);
        
        let stderr = '';
        velora.stderr.on('data', (data) => {
            stderr += data.toString();
            process.stderr.write(data);
        });
        
        velora.stdout.on('data', (data) => {
            process.stdout.write(data);
        });
        
        // Wait for Velora to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Connect to CDP and navigate
        console.log(`\nConnecting to CDP at ws://127.0.0.1:${CDP_PORT}...`);
        const WebSocket = require('ws');
        const ws = new WebSocket(`ws://127.0.0.1:${CDP_PORT}`);
        
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
        });
        
        console.log('Connected to CDP');
        
        let msgId = 1;
        const pending = new Map();
        
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        });
        
        function send(method, params = {}) {
            return new Promise((resolve) => {
                const id = msgId++;
                pending.set(id, resolve);
                ws.send(JSON.stringify({ id, method, params }));
            });
        }
        
        // Navigate to test page
        const testUrl = `http://127.0.0.1:${HTTP_PORT}/test.html`;
        console.log(`\nNavigating to ${testUrl}...`);
        await send('Page.navigate', { url: testUrl });
        
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Evaluate WebGL test
        console.log('\nEvaluating WebGL test...');
        const result = await send('Runtime.evaluate', {
            expression: `
                (function() {
                    const canvas = document.getElementById('canvas');
                    if (!canvas) return { error: 'Canvas not found' };
                    
                    const gl = canvas.getContext('webgl');
                    if (!gl) return { error: 'WebGL context is null' };
                    
                    return {
                        contextCreated: true,
                        vendor: gl.getParameter(gl.VENDOR),
                        renderer: gl.getParameter(gl.RENDERER),
                        version: gl.getParameter(gl.VERSION),
                        extensions: gl.getSupportedExtensions() ? gl.getSupportedExtensions().length : 0
                    };
                })()
            `,
            returnByValue: true
        });
        
        console.log('\n--- RESULT ---');
        console.log('Full response:', JSON.stringify(result, null, 2));
        if (result.result && result.result.value) {
            console.log('\nParsed value:', JSON.stringify(result.result.value, null, 2));
        } else {
            console.log('\nNo result.result.value found');
        }
        
        // Cleanup
        ws.close();
        velora.kill();
        server.close();
        
        process.exit(0);
        
    } catch (err) {
        console.error('\nError:', err.message);
        server.close();
        process.exit(1);
    }
}

// Check if ws module is available
try {
    require.resolve('ws');
    runTest();
} catch (e) {
    console.error('Error: "ws" module not found. Install it with: npm install ws');
    process.exit(1);
}
