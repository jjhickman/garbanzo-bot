export const enum StoreType {
  Sqlite = 0,
}

export declare class DeviceId {
  constructor(value: string);
}

export declare class DeviceLists {
  constructor(changed?: UserId[], left?: UserId[]);
}

export declare class EncryptionSettings {
  algorithm?: number;
  historyVisibility?: number;
  rotationPeriod?: bigint;
  rotationPeriodMessages?: bigint;
}

export declare class OlmMachine {
  static initialize(...args: unknown[]): Promise<never>;
}

export declare class RoomId {
  constructor(value: string);
}

export declare class UserId {
  constructor(value: string);
}

export declare function getVersions(): { matrix_sdk_crypto: string };
