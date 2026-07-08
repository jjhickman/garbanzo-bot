"use strict";

const unavailable = () => {
  throw new Error(
    "Matrix end-to-end encryption is disabled in Garbanzo builds; use unencrypted Matrix rooms.",
  );
};

class MatrixCryptoIdentifier {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

class DeviceId extends MatrixCryptoIdentifier {}
class RoomId extends MatrixCryptoIdentifier {}
class UserId extends MatrixCryptoIdentifier {}

class DeviceLists {
  constructor(changed = [], left = []) {
    this.changed = changed;
    this.left = left;
  }
}

class EncryptionSettings {}

class OlmMachine {
  static async initialize() {
    unavailable();
  }
}

module.exports = {
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  OlmMachine,
  RoomId,
  StoreType: { Sqlite: 0 },
  UserId,
  getVersions: () => ({ matrix_sdk_crypto: "disabled" }),
};
