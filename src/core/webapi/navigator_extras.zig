// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");
const Execution = js.Execution;
const builtin = @import("builtin");
const log = @import("../../support/log.zig");

pub fn registerTypes() []const type {
    return &.{
        MediaDevices,
        Clipboard,
        CredentialsContainer,
        Bluetooth,
        GPU,
        GPUAdapter,
        GPUQueue,
        GPUDevice,
        USB,
        Serial,
        HID,
        Keyboard,
        LockManager,
        WakeLock,
        ContactsManager,
        ServiceWorkerContainer,
        ServiceWorker,
        ServiceWorkerRegistration,
    };
}

fn emptyInterface(comptime interface_name: []const u8) type {
    return struct {
        const Outer = @This();
        _pad: bool = false,
        pub const JsApi = struct {
            pub const bridge = js.Bridge(Outer);
            pub const Meta = struct {
                pub const name = interface_name;
                pub const prototype_chain = bridge.prototypeChain();
                pub var class_id: bridge.ClassId = undefined;
                pub const empty_with_no_proto = true;
            };
        };
    };
}

pub const Bluetooth = struct {
    _pad: bool = false,

    pub fn getAvailability(self: *const Bluetooth, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(@as(bool, true));
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Bluetooth);
        pub const Meta = struct {
            pub const name = "Bluetooth";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const getAvailability = bridge.function(Bluetooth.getAvailability, .{});
    };
};
pub const GPU = struct {
    _pad: bool = false,

    pub fn requestAdapter(self: *const GPU, exec: *Execution) !js.Promise {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        const adapter = try exec._factory.create(GPUAdapter{});
        return local.resolvePromise(adapter);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GPU);
        pub const Meta = struct {
            pub const name = "GPU";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const requestAdapter = bridge.function(GPU.requestAdapter, .{});
    };
};

pub const GPUAdapter = struct {
    _pad: bool = false,

    fn adapterInfoObject(exec: *Execution) !js.Object {
        const local = exec.context.local orelse return error.NotHandled;
        const info = local.newObject();
        _ = try info.set("vendor", "apple", .{});
        _ = try info.set("architecture", "metal-3", .{});
        _ = try info.set("device", "", .{});
        _ = try info.set("description", "", .{});
        return info;
    }

    pub fn getInfo(self: *const GPUAdapter, exec: *Execution) !js.Value {
        _ = self;
        const info = try adapterInfoObject(exec);
        return info.toValue();
    }

    pub fn requestAdapterInfo(self: *const GPUAdapter, exec: *Execution) !js.Promise {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        const info = try adapterInfoObject(exec);
        return local.resolvePromise(info);
    }

    pub fn requestDevice(self: *const GPUAdapter, exec: *Execution) !js.Promise {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        const queue = try exec._factory.create(GPUQueue{});
        const device = try exec._factory.create(GPUDevice{ ._queue = queue });
        return local.resolvePromise(device);
    }

    pub fn getFeatures(self: *const GPUAdapter, exec: *Execution) !js.Value {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        return local.exec("({ values() { return ['depth-clip-control', 'texture-compression-bc', 'timestamp-query'].values(); }, [Symbol.iterator]() { return this.values(); } })", "gpu-features");
    }

    pub fn getLimits(self: *const GPUAdapter, exec: *Execution) !js.Value {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        const limits = local.newObject();
        // macOS Chrome 149 WebGPU limits (M-series Metal).
        _ = try limits.set("maxTextureDimension1D", @as(u32, 16384), .{});
        _ = try limits.set("maxTextureDimension2D", @as(u32, 16384), .{});
        _ = try limits.set("maxTextureDimension3D", @as(u32, 2048), .{});
        _ = try limits.set("maxTextureArrayLayers", @as(u32, 2048), .{});
        _ = try limits.set("maxBindGroups", @as(u32, 4), .{});
        _ = try limits.set("maxBindGroupsPlusVertexBuffers", @as(u32, 24), .{});
        _ = try limits.set("maxBindingsPerBindGroup", @as(u32, 1000), .{});
        _ = try limits.set("maxDynamicUniformBuffersPerPipelineLayout", @as(u32, 10), .{});
        _ = try limits.set("maxDynamicStorageBuffersPerPipelineLayout", @as(u32, 8), .{});
        _ = try limits.set("maxSampledTexturesPerShaderStage", @as(u32, 48), .{});
        _ = try limits.set("maxSamplersPerShaderStage", @as(u32, 16), .{});
        _ = try limits.set("maxStorageBuffersPerShaderStage", @as(u32, 10), .{});
        _ = try limits.set("maxStorageTexturesPerShaderStage", @as(u32, 8), .{});
        _ = try limits.set("maxUniformBuffersPerShaderStage", @as(u32, 12), .{});
        _ = try limits.set("maxUniformBufferBindingSize", @as(u32, 65536), .{});
        _ = try limits.set("maxStorageBufferBindingSize", @as(u64, 4294967292), .{});
        _ = try limits.set("minUniformBufferOffsetAlignment", @as(u32, 256), .{});
        _ = try limits.set("minStorageBufferOffsetAlignment", @as(u32, 256), .{});
        _ = try limits.set("maxVertexBuffers", @as(u32, 8), .{});
        _ = try limits.set("maxBufferSize", @as(u64, 4294967292), .{});
        _ = try limits.set("maxVertexAttributes", @as(u32, 30), .{});
        _ = try limits.set("maxVertexBufferArrayStride", @as(u32, 2048), .{});
        _ = try limits.set("maxInterStageShaderVariables", @as(u32, 28), .{});
        _ = try limits.set("maxColorAttachments", @as(u32, 8), .{});
        _ = try limits.set("maxColorAttachmentBytesPerSample", @as(u32, 128), .{});
        _ = try limits.set("maxComputeWorkgroupStorageSize", @as(u32, 32768), .{});
        _ = try limits.set("maxComputeInvocationsPerWorkgroup", @as(u32, 1024), .{});
        _ = try limits.set("maxComputeWorkgroupSizeX", @as(u32, 1024), .{});
        _ = try limits.set("maxComputeWorkgroupSizeY", @as(u32, 1024), .{});
        _ = try limits.set("maxComputeWorkgroupSizeZ", @as(u32, 64), .{});
        _ = try limits.set("maxComputeWorkgroupsPerDimension", @as(u32, 65535), .{});
        _ = try limits.set("maxStorageBuffersInFragmentStage", @as(u32, 10), .{});
        _ = try limits.set("maxStorageTexturesInFragmentStage", @as(u32, 8), .{});
        _ = try limits.set("maxStorageBuffersInVertexStage", @as(u32, 10), .{});
        _ = try limits.set("maxStorageTexturesInVertexStage", @as(u32, 8), .{});
        return limits.toValue();
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GPUAdapter);
        pub const Meta = struct {
            pub const name = "GPUAdapter";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const name = bridge.attribute("", .{});
        pub const info = bridge.accessor(GPUAdapter.getInfo, null, .{});
        pub const features = bridge.accessor(GPUAdapter.getFeatures, null, .{});
        pub const limits = bridge.accessor(GPUAdapter.getLimits, null, .{});
        pub const isFallbackAdapter = bridge.attribute(false, .{});
        pub const requestAdapterInfo = bridge.function(GPUAdapter.requestAdapterInfo, .{});
        pub const requestDevice = bridge.function(GPUAdapter.requestDevice, .{ .dom_exception = true });
    };
};

pub const GPUQueue = struct {
    _pad: bool = false,

    pub fn submit(self: *const GPUQueue, _: js.Value) void {
        _ = self;
    }

    pub fn onSubmittedWorkDone(self: *const GPUQueue, exec: *Execution) !js.Promise {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GPUQueue);
        pub const Meta = struct {
            pub const name = "GPUQueue";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const submit = bridge.function(GPUQueue.submit, .{});
        pub const onSubmittedWorkDone = bridge.function(GPUQueue.onSubmittedWorkDone, .{});
    };
};

pub const GPUDevice = struct {
    _pad: bool = false,
    _queue: *GPUQueue,

    pub fn getQueue(self: *GPUDevice) *GPUQueue {
        return self._queue;
    }

    pub fn getLost(self: *GPUDevice, exec: *Execution) !js.Promise {
        _ = self;
        const local = exec.context.local orelse return error.NotHandled;
        return local.createPromiseResolver().promise();
    }

    pub fn destroy(self: *GPUDevice) void {
        _ = self;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(GPUDevice);
        pub const Meta = struct {
            pub const name = "GPUDevice";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const queue = bridge.accessor(GPUDevice.getQueue, null, .{});
        pub const lost = bridge.accessor(GPUDevice.getLost, null, .{});
        pub const destroy = bridge.function(GPUDevice.destroy, .{});
    };
};

pub const USB = emptyInterface("USB");
pub const Serial = emptyInterface("Serial");
pub const HID = emptyInterface("HID");
pub const Keyboard = emptyInterface("Keyboard");
pub const MediaDevices = struct {
    _pad: bool = false,

    const MediaDeviceInfo = struct {
        _device_id: []const u8,
        _group_id: []const u8,
        _kind: []const u8,
        _label: []const u8,

        pub fn getDeviceId(self: *const MediaDeviceInfo) []const u8 {
            return self._device_id;
        }

        pub fn getGroupId(self: *const MediaDeviceInfo) []const u8 {
            return self._group_id;
        }

        pub fn getKind(self: *const MediaDeviceInfo) []const u8 {
            return self._kind;
        }

        pub fn getLabel(self: *const MediaDeviceInfo) []const u8 {
            return self._label;
        }

        pub const JsApi = struct {
            pub const bridge = js.Bridge(MediaDeviceInfo);
            pub const Meta = struct {
                pub const name = "MediaDeviceInfo";
                pub const prototype_chain = bridge.prototypeChain();
                pub var class_id: bridge.ClassId = undefined;
                pub const empty_with_no_proto = true;
            };
            pub const deviceId = bridge.accessor(MediaDeviceInfo.getDeviceId, null, .{});
            pub const groupId = bridge.accessor(MediaDeviceInfo.getGroupId, null, .{});
            pub const kind = bridge.accessor(MediaDeviceInfo.getKind, null, .{});
            pub const label = bridge.accessor(MediaDeviceInfo.getLabel, null, .{});
        };
    };

    pub fn enumerateDevices(self: *const MediaDevices, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;

        const mic = local.newObject();
        _ = try mic.set("deviceId", "default-audio-input", .{});
        _ = try mic.set("groupId", "default-av-group", .{});
        _ = try mic.set("kind", "audioinput", .{});
        _ = try mic.set("label", "Default Microphone", .{});

        const speaker = local.newObject();
        _ = try speaker.set("deviceId", "default-audio-output", .{});
        _ = try speaker.set("groupId", "default-av-group", .{});
        _ = try speaker.set("kind", "audiooutput", .{});
        _ = try speaker.set("label", "Default Speakers", .{});

        const webcam = local.newObject();
        _ = try webcam.set("deviceId", "default-video-input", .{});
        _ = try webcam.set("groupId", "default-av-group", .{});
        _ = try webcam.set("kind", "videoinput", .{});
        _ = try webcam.set("label", "FaceTime HD Camera", .{});

        const arr = local.newArray(3);
        _ = try arr.set(0, mic.toValue(), .{});
        _ = try arr.set(1, speaker.toValue(), .{});
        _ = try arr.set(2, webcam.toValue(), .{});
        return local.resolvePromise(arr);
    }

    pub fn getUserMedia(self: *const MediaDevices, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub fn getDisplayMedia(self: *const MediaDevices, _: js.Value, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(MediaDevices);
        pub const Meta = struct {
            pub const name = "MediaDevices";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const enumerateDevices = bridge.function(MediaDevices.enumerateDevices, .{});
        pub const getUserMedia = bridge.function(MediaDevices.getUserMedia, .{ .dom_exception = true });
        pub const getDisplayMedia = bridge.function(MediaDevices.getDisplayMedia, .{ .dom_exception = true });
    };
};

pub const Clipboard = struct {
    _pad: bool = false,

    pub fn readText(self: *const Clipboard, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newString(""));
    }

    pub fn writeText(self: *const Clipboard, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Clipboard);
        pub const Meta = struct {
            pub const name = "Clipboard";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const readText = bridge.function(Clipboard.readText, .{});
        pub const writeText = bridge.function(Clipboard.writeText, .{});
    };
};

pub const CredentialsContainer = struct {
    _pad: bool = false,

    pub fn get(self: *const CredentialsContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(null);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(CredentialsContainer);
        pub const Meta = struct {
            pub const name = "CredentialsContainer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const get = bridge.function(CredentialsContainer.get, .{});
    };
};

pub const LockManager = struct {
    _pad: bool = false,

    pub fn request(self: *const LockManager, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        const obj = local.newObject();
        return local.resolvePromise(obj);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(LockManager);
        pub const Meta = struct {
            pub const name = "LockManager";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const request = bridge.function(LockManager.request, .{});
    };
};

pub const WakeLock = struct {
    _pad: bool = false,

    pub fn request(self: *const WakeLock, _: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(WakeLock);
        pub const Meta = struct {
            pub const name = "WakeLock";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const request = bridge.function(WakeLock.request, .{ .dom_exception = true });
    };
};

pub const ContactsManager = struct {
    _pad: bool = false,

    pub fn select(self: *const ContactsManager, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.rejectPromise(.{ .dom_exception = .{ .err = error.SecurityError } });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ContactsManager);
        pub const Meta = struct {
            pub const name = "ContactsManager";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
            // Chrome macOS: navigator.contacts exists but ContactsManager is not on window.
            pub const skip_global = true;
        };
        pub const select = bridge.function(ContactsManager.select, .{ .dom_exception = true });
    };
};

pub const ServiceWorkerContainer = struct {
    _pad: bool = false,

    pub fn getController(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getReady(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getRegistration(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getRegistrations(self: *const ServiceWorkerContainer, frame: *Frame) !js.Promise {
        _ = self;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(local.newArray(0));
    }

    pub fn register(self: *const ServiceWorkerContainer, script_url: []const u8, frame: *Frame) !js.Promise {
        _ = self;
        _ = script_url;
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ServiceWorkerContainer);
        pub const Meta = struct {
            pub const name = "ServiceWorkerContainer";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const controller = bridge.function(ServiceWorkerContainer.getController, .{});
        pub const ready = bridge.accessor(ServiceWorkerContainer.getReady, null, .{});
        pub const getRegistration = bridge.function(ServiceWorkerContainer.getRegistration, .{});
        pub const getRegistrations = bridge.function(ServiceWorkerContainer.getRegistrations, .{});
        pub const register = bridge.function(ServiceWorkerContainer.register, .{});
    };
};

pub const ServiceWorker = struct {
    _script_url: []const u8,
    _state: []const u8 = "activated",

    pub fn getScriptURL(self: *const ServiceWorker) []const u8 {
        return self._script_url;
    }

    pub fn getState(self: *const ServiceWorker) []const u8 {
        return self._state;
    }

    pub fn postMessage(self: *ServiceWorker, message: js.Value, _: *Frame) void {
        if (builtin.mode == .Debug) {
            log.err(.browser, "SERVICE_WORKER_POST_MESSAGE", .{});
        }
        _ = self;
        _ = message;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ServiceWorker);
        pub const Meta = struct {
            pub const name = "ServiceWorker";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const scriptURL = bridge.accessor(ServiceWorker.getScriptURL, null, .{});
        pub const state = bridge.accessor(ServiceWorker.getState, null, .{});
        pub const postMessage = bridge.function(ServiceWorker.postMessage, .{});
    };
};

pub const ServiceWorkerRegistration = struct {
    _scope: []const u8,
    _update_via_cache: []const u8 = "imports",

    pub fn getScope(self: *const ServiceWorkerRegistration, _: *Frame) []const u8 {
        return self._scope;
    }

    pub fn getUpdateViaCache(self: *const ServiceWorkerRegistration, _: *Frame) []const u8 {
        return self._update_via_cache;
    }

    pub fn unregister(self: *const ServiceWorkerRegistration, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        _ = self;
        return local.resolvePromise(true);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(ServiceWorkerRegistration);
        pub const Meta = struct {
            pub const name = "ServiceWorkerRegistration";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };

        pub const scope = bridge.accessor(ServiceWorkerRegistration.getScope, null, .{});
        pub const updateViaCache = bridge.accessor(ServiceWorkerRegistration.getUpdateViaCache, null, .{});
        pub const unregister = bridge.function(ServiceWorkerRegistration.unregister, .{});
    };
};
