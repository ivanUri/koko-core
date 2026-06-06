#!/usr/bin/env node
// Test getImageData() returns actual pixels from PixelBuffer

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const CDP = require("chrome-remote-interface");

const veloraBin = resolve(__dirname, "../zig-out/bin/velora");

async function test() {
  console.log("[test] Launching Velora...");
  const proc = spawn(veloraBin, [
    "serve",
    "--host", "127.0.0.1",
    "--port", "62032",
    "--log-level", "error",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const client = await CDP({ port: 62032 });
    const { Page, Runtime } = client;
    
    await Page.enable();
    await Runtime.enable();
    await Page.navigate({ url: "about:blank" });
    await Page.loadEventFired();
    
    const { result } = await Runtime.evaluate({
      expression: `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 10;
      canvas.height = 10;
      const ctx = canvas.getContext('2d');
      
      // Fill with specific color: red
      ctx.fillStyle = 'rgb(255, 0, 0)';
      ctx.fillRect(2, 2, 5, 5);
      
      // Get image data
      const imageData = ctx.getImageData(0, 0, 10, 10);
      
      // Check pixel at (2, 2) - should be red
      const redPixelIdx = (2 * 10 + 2) * 4;
      const redPixel = {
        r: imageData.data[redPixelIdx],
        g: imageData.data[redPixelIdx + 1],
        b: imageData.data[redPixelIdx + 2],
        a: imageData.data[redPixelIdx + 3]
      };
      
      // Check pixel at (0, 0) - should be transparent
      const transparentPixel = {
        r: imageData.data[0],
        g: imageData.data[1],
        b: imageData.data[2],
        a: imageData.data[3]
      };
      
      // Check pixel at (7, 7) - should be transparent (outside fillRect)
      const outsideIdx = (7 * 10 + 7) * 4;
      const outsidePixel = {
        r: imageData.data[outsideIdx],
        g: imageData.data[outsideIdx + 1],
        b: imageData.data[outsideIdx + 2],
        a: imageData.data[outsideIdx + 3]
      };
      
        return {
          redPixel,
          transparentPixel,
          outsidePixel,
          totalPixels: imageData.data.length / 4,
          dataLength: imageData.data.length
        };
      })()`,
      returnByValue: true,
    });
    
    const testResult = result.value;
    
    console.log('\ngetImageData() test results:');
    console.log('==============================');
    console.log('Red pixel (2,2):', testResult.redPixel);
    console.log('  Expected: {r: 255, g: 0, b: 0, a: 255}');
    console.log('  Match:', testResult.redPixel.r === 255 && testResult.redPixel.g === 0 && testResult.redPixel.b === 0 && testResult.redPixel.a === 255 ? '✓' : '✗');
    
    console.log('\nTransparent pixel (0,0):', testResult.transparentPixel);
    console.log('  Expected: {r: 0, g: 0, b: 0, a: 0}');
    console.log('  Match:', testResult.transparentPixel.a === 0 ? '✓' : '✗');
    
    console.log('\nOutside pixel (7,7):', testResult.outsidePixel);
    console.log('  Expected: {r: 0, g: 0, b: 0, a: 0}');
    console.log('  Match:', testResult.outsidePixel.a === 0 ? '✓' : '✗');
    
    console.log('\nTotal pixels:', testResult.totalPixels, '(expected 100)');
    console.log('Data length:', testResult.dataLength, '(expected 400)');
    
    await client.close();
    proc.kill();
    
    const allMatch = 
      testResult.redPixel.r === 255 && testResult.redPixel.g === 0 && testResult.redPixel.b === 0 && testResult.redPixel.a === 255 &&
      testResult.transparentPixel.a === 0 &&
      testResult.outsidePixel.a === 0;
    
    console.log('\n' + (allMatch ? '✓ PASS: getImageData() returns actual pixels!' : '✗ FAIL: Pixel mismatch'));
    process.exit(allMatch ? 0 : 1);
    
  } catch (error) {
    console.error('Error:', error);
    proc.kill();
    process.exit(1);
  }
}

test();
