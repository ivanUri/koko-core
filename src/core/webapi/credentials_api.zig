// Credential Management / WebAuthn types for Google Accounts boq-identity.

const js = @import("../js/js.zig");
const Frame = @import("../browser/Frame.zig");

const Execution = js.Execution;

pub fn registerTypes() []const type {
    return &.{
        Credential,
        PasswordCredential,
        FederatedCredential,
        PublicKeyCredential,
        IdentityCredential,
        DigitalCredential,
        OTPCredential,
        AuthenticatorResponse,
        AuthenticatorAssertionResponse,
        AuthenticatorAttestationResponse,
        IdentityProvider,
        NavigatorLogin,
    };
}

pub const Credential = struct {
    _pad: bool = false,
    _id: []const u8 = "",
    _type: []const u8 = "",

    pub fn getId(self: *const Credential) []const u8 {
        return self._id;
    }

    pub fn getType(self: *const Credential) []const u8 {
        return self._type;
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(Credential);
        pub const Meta = struct {
            pub const name = "Credential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const id = bridge.accessor(Credential.getId, null, .{});
        pub const @"type" = bridge.accessor(Credential.getType, null, .{});
    };
};

pub const PasswordCredential = struct {
    _proto: *Credential,
    _id: []const u8 = "",
    _type: []const u8 = "password",

    pub fn init(_: js.Value, exec: *const Execution) !*PasswordCredential {
        return exec._factory.credentialLeaf(PasswordCredential{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(PasswordCredential);
        pub const Meta = struct {
            pub const name = "PasswordCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(PasswordCredential.init, .{});
    };
};

pub const FederatedCredential = struct {
    _proto: *Credential,

    pub fn init(exec: *const Execution) !*FederatedCredential {
        return exec._factory.credentialLeaf(FederatedCredential{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(FederatedCredential);
        pub const Meta = struct {
            pub const name = "FederatedCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(FederatedCredential.init, .{});
    };
};

pub const IdentityCredential = struct {
    _proto: *Credential,

    pub fn init(exec: *const Execution) !*IdentityCredential {
        return exec._factory.credentialLeaf(IdentityCredential{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IdentityCredential);
        pub const Meta = struct {
            pub const name = "IdentityCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(IdentityCredential.init, .{});
    };
};

pub const DigitalCredential = struct {
    _proto: *Credential,
    _type: []const u8 = "digital",

    pub fn init(exec: *const Execution) !*DigitalCredential {
        return exec._factory.credentialLeaf(DigitalCredential{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(DigitalCredential);
        pub const Meta = struct {
            pub const name = "DigitalCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(DigitalCredential.init, .{});
    };
};

pub const OTPCredential = struct {
    _proto: *Credential,

    pub fn init(exec: *const Execution) !*OTPCredential {
        return exec._factory.credentialLeaf(OTPCredential{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(OTPCredential);
        pub const Meta = struct {
            pub const name = "OTPCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(OTPCredential.init, .{});
    };
};

pub const PublicKeyCredential = struct {
    _proto: *Credential,

    pub fn init(exec: *const Execution) !*PublicKeyCredential {
        return exec._factory.credentialLeaf(PublicKeyCredential{
            ._proto = undefined,
        });
    }

    pub fn isUserVerifyingPlatformAuthenticatorAvailable(_: *const PublicKeyCredential, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(false);
    }

    pub fn isConditionalMediationAvailable(_: *const PublicKeyCredential, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(false);
    }

    pub fn isExternalCTAP2SecurityKeySupported(_: *const PublicKeyCredential, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(false);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(PublicKeyCredential);
        pub const Meta = struct {
            pub const name = "PublicKeyCredential";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = Credential;
        pub const constructor = bridge.constructor(PublicKeyCredential.init, .{});
        pub const isUserVerifyingPlatformAuthenticatorAvailable = bridge.function(
            PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable,
            .{ .static = true },
        );
        pub const isConditionalMediationAvailable = bridge.function(
            PublicKeyCredential.isConditionalMediationAvailable,
            .{ .static = true },
        );
        pub const isExternalCTAP2SecurityKeySupported = bridge.function(
            PublicKeyCredential.isExternalCTAP2SecurityKeySupported,
            .{ .static = true },
        );
    };
};

fn emptyArrayBuffer(frame: *Frame) !js.Value {
    const local = frame.js.local orelse return error.NotHandled;
    const ab = js.v8.v8__ArrayBuffer__New(frame.js.isolate.handle, 0).?;
    return .{ .local = local, .handle = @ptrCast(ab) };
}

pub const AuthenticatorResponse = struct {
    _pad: bool = false,

    pub fn getClientDataJSON(_: *const AuthenticatorResponse, frame: *Frame) !js.Value {
        return emptyArrayBuffer(frame);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AuthenticatorResponse);
        pub const Meta = struct {
            pub const name = "AuthenticatorResponse";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const clientDataJSON = bridge.accessor(AuthenticatorResponse.getClientDataJSON, null, .{});
    };
};

pub const AuthenticatorAssertionResponse = struct {
    _proto: *AuthenticatorResponse,

    pub fn init(exec: *const Execution) !*AuthenticatorAssertionResponse {
        return exec._factory.authenticatorResponseLeaf(AuthenticatorAssertionResponse{
            ._proto = undefined,
        });
    }

    pub fn getAuthenticatorData(_: *const AuthenticatorAssertionResponse, frame: *Frame) !js.Value {
        return emptyArrayBuffer(frame);
    }

    pub fn getSignature(_: *const AuthenticatorAssertionResponse, frame: *Frame) !js.Value {
        return emptyArrayBuffer(frame);
    }

    pub fn getUserHandle(_: *const AuthenticatorAssertionResponse, frame: *Frame) !js.Value {
        return emptyArrayBuffer(frame);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AuthenticatorAssertionResponse);
        pub const Meta = struct {
            pub const name = "AuthenticatorAssertionResponse";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = AuthenticatorResponse;
        pub const constructor = bridge.constructor(AuthenticatorAssertionResponse.init, .{});
        pub const authenticatorData = bridge.accessor(AuthenticatorAssertionResponse.getAuthenticatorData, null, .{});
        pub const signature = bridge.accessor(AuthenticatorAssertionResponse.getSignature, null, .{});
        pub const userHandle = bridge.accessor(AuthenticatorAssertionResponse.getUserHandle, null, .{});
    };
};

pub const AuthenticatorAttestationResponse = struct {
    _proto: *AuthenticatorResponse,

    pub fn init(exec: *const Execution) !*AuthenticatorAttestationResponse {
        return exec._factory.authenticatorResponseLeaf(AuthenticatorAttestationResponse{
            ._proto = undefined,
        });
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(AuthenticatorAttestationResponse);
        pub const Meta = struct {
            pub const name = "AuthenticatorAttestationResponse";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
        };
        pub const Prototype = AuthenticatorResponse;
        pub const constructor = bridge.constructor(AuthenticatorAttestationResponse.init, .{});
    };
};

pub const IdentityProvider = struct {
    _pad: bool = false,

    pub fn close(_: *const IdentityProvider, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub fn getUserInfo(_: *const IdentityProvider, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(null);
    }

    pub fn resolve(_: *const IdentityProvider, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(null);
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(IdentityProvider);
        pub const Meta = struct {
            pub const name = "IdentityProvider";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const close = bridge.function(IdentityProvider.close, .{ .static = true });
        pub const getUserInfo = bridge.function(IdentityProvider.getUserInfo, .{ .static = true });
        pub const resolve = bridge.function(IdentityProvider.resolve, .{ .static = true });
    };
};

pub const NavigatorLogin = struct {
    _pad: bool = false,

    pub fn setStatus(_: *const NavigatorLogin, frame: *Frame) !js.Promise {
        const local = frame.js.local orelse return error.NotHandled;
        return local.resolvePromise(js.Undefined{});
    }

    pub const JsApi = struct {
        pub const bridge = js.Bridge(NavigatorLogin);
        pub const Meta = struct {
            pub const name = "NavigatorLogin";
            pub const prototype_chain = bridge.prototypeChain();
            pub var class_id: bridge.ClassId = undefined;
            pub const empty_with_no_proto = true;
        };
        pub const setStatus = bridge.function(NavigatorLogin.setStatus, .{});
    };
};
