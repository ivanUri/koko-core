#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8912;
const CDP_PORT = 8913;

// Simple HTTP server
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, '..', 'velora-test', 'webgl-getparam-test.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n=== WebGL getParameter Test ===\n`);
  console.log(`HTTP server listening on http://127.0.0.1:${PORT}`);
  
  // Start Velora
  const velora = spawn('./zig-out/bin/velora', [
    'serve',
    '--host', '127.0.0.1',
    '--port', CDP_PORT.toString(),
    '--log-level', 'info'
  ]);
  
  console.log(`Starting Velora with CDP on port ${CDP_PORT}...`);
  
  velora.stdout.on('data', (data) => {
    process.stdout.write(data);
  });
  
  velora.stderr.on('data', (data) => {
    process.stderr.write(data);
  });
  
  // Wait a bit for Velora to start
  setTimeout(() => {
    const ws = new WebSocket(`ws://127.0.0.1:${CDP_PORT}`);
    
    ws.on('open', () => {
      console.log(`\nConnected to CDP\n`);
      
      // Navigate to test page
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.navigate',
        params: { url: `http://127.0.0.1:${PORT}` }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = msg.params.args || [];
        console.log('\n--- Console Output ---');
        args.forEach(arg => {
          console.log(arg.value || arg.description || JSON.stringify(arg));
        });
      }
      
      if (msg.id === 1 && msg.result) {
        console.log('Navigation complete\n');
        
        // Wait a bit for page to execute
        setTimeout(() => {
          // Get the output
          ws.send(JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression: 'document.getElementById("output").textContent',
              returnByValue: true
            }
          }));
        }, 1000);
      }
      
      if (msg.id === 2) {
        console.log('\n--- WebGL getParameter Results ---\n');
        if (msg.result && msg.result.result) {
          console.log(msg.result.result.value);
        } else {
          console.log('No results found');
          console.log(JSON.stringify(msg, null, 2));
        }
        
        // Cleanup
        ws.close();
        velora.kill();
        server.close();
        process.exit(0);
      }
    });
    
    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      velora.kill();
      server.close();
      process.exit(1);
    });
  }, 2000);
  
  velora.on('exit', (code) => {
    console.log(`\nVelora exited with code ${code}`);
    server.close();
  });
});
