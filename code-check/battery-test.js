// Test navigator.getBattery() API implementation

async function testBattery() {
    console.log('Testing navigator.getBattery()...');

    // Test 1: getBattery should exist
    if (typeof navigator.getBattery !== 'function') {
        console.error('FAIL: navigator.getBattery is not a function');
        return false;
    }
    console.log('✓ navigator.getBattery exists');

    // Test 2: getBattery should return a Promise
    const batteryPromise = navigator.getBattery();
    if (!(batteryPromise instanceof Promise)) {
        console.error('FAIL: navigator.getBattery() did not return a Promise');
        return false;
    }
    console.log('✓ navigator.getBattery() returns a Promise');

    // Test 3: Promise should resolve to BatteryManager
    const battery = await batteryPromise;
    if (!battery) {
        console.error('FAIL: Promise did not resolve to a battery object');
        return false;
    }
    console.log('✓ Promise resolved to battery object');

    // Test 4: Check constructor name
    if (battery.constructor.name !== 'BatteryManager') {
        console.error('FAIL: constructor.name is not "BatteryManager", got:', battery.constructor.name);
        return false;
    }
    console.log('✓ battery.constructor.name === "BatteryManager"');

    // Test 5: Check Object.prototype.toString
    const toStringResult = Object.prototype.toString.call(battery);
    if (toStringResult !== '[object BatteryManager]') {
        console.error('FAIL: Object.prototype.toString.call(battery) is not "[object BatteryManager]", got:', toStringResult);
        return false;
    }
    console.log('✓ Object.prototype.toString.call(battery) === "[object BatteryManager]"');

    // Test 6: Check EventTarget inheritance
    if (!(battery instanceof EventTarget)) {
        console.error('FAIL: battery is not an instance of EventTarget');
        return false;
    }
    console.log('✓ battery instanceof EventTarget === true');

    // Test 7: Check properties exist
    const requiredProps = ['charging', 'chargingTime', 'dischargingTime', 'level'];
    for (const prop of requiredProps) {
        if (!(prop in battery)) {
            console.error(`FAIL: battery.${prop} does not exist`);
            return false;
        }
    }
    console.log('✓ All required properties exist');

    // Test 8: Check property values
    console.log('  - charging:', battery.charging);
    console.log('  - chargingTime:', battery.chargingTime);
    console.log('  - dischargingTime:', battery.dischargingTime);
    console.log('  - level:', battery.level);

    if (typeof battery.charging !== 'boolean') {
        console.error('FAIL: battery.charging is not a boolean');
        return false;
    }
    if (typeof battery.chargingTime !== 'number') {
        console.error('FAIL: battery.chargingTime is not a number');
        return false;
    }
    if (typeof battery.dischargingTime !== 'number') {
        console.error('FAIL: battery.dischargingTime is not a number');
        return false;
    }
    if (typeof battery.level !== 'number') {
        console.error('FAIL: battery.level is not a number');
        return false;
    }
    console.log('✓ All property types are correct');

    // Test 9: Check event handlers exist
    const eventHandlers = ['onchargingchange', 'onchargingtimechange', 'ondischargingtimechange', 'onlevelchange'];
    for (const handler of eventHandlers) {
        if (!(handler in battery)) {
            console.error(`FAIL: battery.${handler} does not exist`);
            return false;
        }
    }
    console.log('✓ All event handlers exist');

    // Test 10: Check Reflect.ownKeys returns empty array
    const ownKeys = Reflect.ownKeys(battery);
    if (ownKeys.length !== 0) {
        console.error('FAIL: Reflect.ownKeys(battery) should return [], got:', ownKeys);
        return false;
    }
    console.log('✓ Reflect.ownKeys(battery) === []');

    // Test 11: Check prototype keys
    const proto = Object.getPrototypeOf(battery);
    const protoKeys = Object.getOwnPropertyNames(proto).sort();
    console.log('  Prototype keys:', protoKeys);

    const expectedKeys = [
        'charging',
        'chargingTime',
        'dischargingTime',
        'level',
        'onchargingchange',
        'onchargingtimechange',
        'ondischargingtimechange',
        'onlevelchange',
        'constructor'
    ].sort();

    // Check if all expected keys are present
    for (const key of expectedKeys) {
        if (!protoKeys.includes(key)) {
            console.warn(`WARN: Expected prototype key "${key}" not found`);
        }
    }
    console.log('✓ Prototype keys checked');

    // Test 12: Repeated calls should work
    const battery2 = await navigator.getBattery();
    if (!battery2) {
        console.error('FAIL: Second call to getBattery() failed');
        return false;
    }
    console.log('✓ Repeated calls work correctly');

    console.log('\n✅ All tests passed!');
    return true;
}

testBattery().catch(err => {
    console.error('❌ Test failed with error:', err);
});
