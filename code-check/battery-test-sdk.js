const { Browser } = require('../sdk/src/index.ts');

async function testBattery() {
    const browser = new Browser();

    try {
        await browser.start();
        const page = await browser.newPage();

        // Navigate to a simple page
        await page.navigate('data:text/html,<html><body>Test</body></html>');

        // Test the battery API
        const result = await page.evaluate(async () => {
            const results = [];

            // Test 1: getBattery exists
            results.push({ test: 'getBattery exists', pass: typeof navigator.getBattery === 'function' });

            // Test 2: Returns a Promise
            const batteryPromise = navigator.getBattery();
            results.push({ test: 'Returns Promise', pass: batteryPromise instanceof Promise });

            // Test 3: Resolve to BatteryManager
            const battery = await batteryPromise;
            results.push({ test: 'Resolves to object', pass: !!battery });

            // Test 4: Constructor name
            results.push({
                test: 'Constructor name',
                pass: battery.constructor.name === 'BatteryManager',
                value: battery.constructor.name
            });

            // Test 5: toString
            const toStringResult = Object.prototype.toString.call(battery);
            results.push({
                test: 'Object.prototype.toString',
                pass: toStringResult === '[object BatteryManager]',
                value: toStringResult
            });

            // Test 6: EventTarget inheritance
            results.push({
                test: 'instanceof EventTarget',
                pass: battery instanceof EventTarget
            });

            // Test 7: Properties exist
            const props = ['charging', 'chargingTime', 'dischargingTime', 'level'];
            const propsExist = props.every(p => p in battery);
            results.push({ test: 'Properties exist', pass: propsExist });

            // Test 8: Property values
            results.push({
                test: 'Property values',
                pass: true,
                values: {
                    charging: battery.charging,
                    chargingTime: battery.chargingTime,
                    dischargingTime: battery.dischargingTime,
                    level: battery.level
                }
            });

            // Test 9: Event handlers
            const handlers = ['onchargingchange', 'onchargingtimechange', 'ondischargingtimechange', 'onlevelchange'];
            const handlersExist = handlers.every(h => h in battery);
            results.push({ test: 'Event handlers exist', pass: handlersExist });

            // Test 10: Reflect.ownKeys
            const ownKeys = Reflect.ownKeys(battery);
            results.push({
                test: 'Reflect.ownKeys empty',
                pass: ownKeys.length === 0,
                value: ownKeys.length
            });

            return results;
        });

        console.log('\n=== Battery API Test Results ===\n');
        let passed = 0;
        let failed = 0;

        for (const r of result) {
            if (r.pass) {
                console.log(`✓ ${r.test}`);
                if (r.value !== undefined) console.log(`  Value: ${JSON.stringify(r.value)}`);
                if (r.values !== undefined) console.log(`  Values: ${JSON.stringify(r.values, null, 2)}`);
                passed++;
            } else {
                console.log(`✗ ${r.test}`);
                if (r.value !== undefined) console.log(`  Got: ${JSON.stringify(r.value)}`);
                failed++;
            }
        }

        console.log(`\n${passed} passed, ${failed} failed\n`);

        if (failed === 0) {
            console.log('✅ All tests passed!');
        } else {
            console.log('❌ Some tests failed');
            process.exit(1);
        }

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

testBattery();
