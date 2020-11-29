import { PlatformAccessory } from "homebridge";
import { YeelighterPlatform } from "./platform";
import { MODEL_SPECS, EMPTY_SPECS, Specs } from "./specs";
import { Device, DeviceInfo } from "./yeedevice";
import { Attributes, EMPTY_ATTRIBUTES, ConcreteLightService } from "./lightservice";
import { ColorLightService } from "./colorlightservice";
import { WhiteLightService } from "./whitelightservice";
import { TemperatureLightService } from "./temperaturelightservice";
import { BackgroundLightService} from "./backgroundlightservice";


export const TRACKED_ATTRIBUTES = Object.keys(EMPTY_ATTRIBUTES);

interface IncomingMessage {
  id?: number;
  result?: any[];
  error?: any;
}

export interface OverrideLightConfiguration {
  id: string;
  name?: string;
  color?: boolean;
  backgroundLight?: boolean;
  nightLight?: boolean;
  ignored?: boolean;
  colorTemperature?: ColorTemperatureConfiguration;
  log?: boolean;
  offOnDisconnect?: boolean;
  useNameAsId?: boolean;
  [k: string]: any;
}

export interface ColorTemperatureConfiguration {
  min: number;
  max: number;
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject("timeout");
    }, ms);
  });
}

const nameCount = new Map<string, number>();

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timestamp: number;
}


/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class YeeAccessory {
  private services: ConcreteLightService[] = [];
  private detailedLogging = false;
  public connected: boolean;
  public readonly name: string;
  public readonly specs: Specs;
  public displayName = "unset";
  private support: string[];
  private updateTimestamp: number;
  private updateResolve?: (update: string[]) => void;
  private updateReject?: () => void;
  private updatePromise?: Promise<string[]>;
  private updatePromisePending: boolean;
  private attributes: Attributes = { ...EMPTY_ATTRIBUTES };
  private lastCommandId = 1;
  private queryTimestamp = 0;
  public overrideConfig?: OverrideLightConfiguration;
  private interval?: NodeJS.Timeout;
  private transactions = new Map<number, Deferred<void>>();

  private static handledAccessories = new Map<string, YeeAccessory>();

  public static instance(device: Device, platform: YeelighterPlatform, accessory: PlatformAccessory) {
    const cache = YeeAccessory.handledAccessories.get(device.info.id);
    if (cache) {
      return cache;
    }
    const a = new YeeAccessory(platform, accessory, device);
    YeeAccessory.handledAccessories.set(device.info.id, a);
    return a;
  }

  private constructor(
    private readonly platform: YeelighterPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly device: Device
  ) {
    const deviceInfo: DeviceInfo = accessory.context.device;
    const support = deviceInfo.support.split(" ");
    let specs = MODEL_SPECS[deviceInfo.model];
    let name = deviceInfo.id;
    this.connected = false;
    const override: OverrideLightConfiguration[] = platform.config.override as OverrideLightConfiguration[] || [];
  
    if (!specs) {
      specs = { ...EMPTY_SPECS };
      this.warn(
        `no specs for light ${deviceInfo.id} ${deviceInfo.model}. 
        It supports: ${deviceInfo.support}. Using fallback. This will not give you nightLight support.`,
      );
      specs.name = deviceInfo.model;
      specs.color = support.includes("set_hsv");
      specs.backgroundLight = support.includes("bg_set_hsv");
      specs.nightLight = false;
      if (!support.includes("set_ct_abx")) {
        specs.colorTemperature.min = 0;
        specs.colorTemperature.max = 0;
      }
    
    }
    const overrideConfig: OverrideLightConfiguration | undefined = override?.find(
      item => item.id === deviceInfo.id,
    );
    if (overrideConfig?.backgroundLight) {
      specs.backgroundLight = overrideConfig.backgroundLight;
    }
    if (overrideConfig?.color) {
      specs.color = overrideConfig.color;
    }
    if (overrideConfig?.name) {
      name = overrideConfig.name;
    }
    this.name = name;
    if (overrideConfig?.nightLight) {
      specs.nightLight = overrideConfig.nightLight;
    }
    this.specs = specs;
    this.detailedLogging = !!overrideConfig?.log;

    this.connectDevice(this.device);

    let typeString = "UNKNOWN";
    const parameters = {
      accessory,
      platform,
      light: this,
    };
    if (specs.color) {
      this.services.push(new ColorLightService(parameters));
      typeString = "Color light";
    } else {
      if (specs.colorTemperature.min === 0 && specs.colorTemperature.max === 0) {
        this.services.push(new WhiteLightService(parameters));
        typeString = "White light";
      } else {
        this.services.push(new TemperatureLightService(parameters));
        typeString = "Color temperature light";
      }
    }
    if (support.includes("bg_set_power")) {
      this.services.push(new BackgroundLightService(parameters));
      typeString = `${typeString} with mood light`;
    }

    this.support = support;
    this.updateTimestamp = 0;
    this.updatePromisePending = false;

    this.setInfoService(overrideConfig);
    this.log(`installed as ${typeString}`);
  }

  get info() {
    return this.device.info;
  }

  protected get config(): OverrideLightConfiguration {
    const override = (this.platform.config.override || []) as OverrideLightConfiguration[];
    const { device } = this.accessory.context;
    const overrideConfig: OverrideLightConfiguration | undefined = override.find(
      item => item.id === device.id,
    );

    return overrideConfig || { id: device.id };
  }

  public log = (message?: unknown, ...optionalParameters: unknown[]): void => {
    this.platform.log.info(`[${this.name}] ${message}`, optionalParameters);
  };

  public warn = (message?: unknown, ...optionalParameters: unknown[]): void => {
    this.platform.log.warn(`[${this.name}] ${message}`, optionalParameters);
  };

  public error = (message?: unknown, ...optionalParameters: unknown[]): void => {
    this.platform.log.error(`[${this.name}] ${message}`, optionalParameters);
  };

  public getAttributes = async (): Promise<Attributes> => {
    if (this.config?.blocking) {
      if (this.updateTimestamp < Date.now() - 1000 && (!this.updatePromise || !this.updatePromisePending)) {
        // make sure we don't query in parallel and not more often than every second
        this.updatePromise = new Promise<string[]>((resolve, reject) => {
          this.updatePromisePending = true;
          this.updateResolve = resolve;
          this.updateReject = reject;
          this.requestAttributes();
        });
      }
      // this promise will be awaited for by everybody entering here while a request is still in the air
      if (this.updatePromise && this.connected) {
        try {
          await Promise.race([this.updatePromise, timeout(this.config?.timeout)]);
        } catch (error) {
          this.log("retrieving attributes failed. Using last attributes.", error);
        }
      }
    }
    return this.attributes;
  };

  public setAttributes(attributes: Partial<Attributes>) {
    this.attributes = { ...this.attributes, ...attributes };
  }

  private onDeviceUpdate = (update: IncomingMessage) => {
    const { id, result, error } = update;
    if (!id) {
      // this is some strange unknown message
      this.log("unknown response", update);
      return;
    }
    const transaction = this.transactions.get(id);
    if (!transaction) {
      this.warn(`no transactions found for ${id}`, update);
    }
    if (transaction) {
      const seconds = (Date.now() - transaction.timestamp) / 1000;
      this.log(`transaction ${id} took ${seconds}s`, update);
    }
    this.transactions.delete(id);
    if (result && result.length === 1 && result[0] === "ok") {
      this.connected = true;
      if (this.detailedLogging) {
        this.log(`received ${id}: OK`);
      }
      transaction?.resolve();
      // simple ok
    } else if (result && result.length > 3) {
      this.connected = true;
      if (this.lastCommandId !== id) {
        this.warn(`update with unexpected id: ${id}, expected: ${this.lastCommandId}`);
      }
      const seconds = (Date.now() - this.queryTimestamp) / 1000;
      this.log(`received update ${id} after ${seconds}s: ${JSON.stringify(result)}`);
      if (this.updateResolve) {
        // resolve the promise and delete the resolvers
        this.updateResolve(result);
        this.updatePromisePending = false;
        delete this.updateResolve;
        delete this.updateReject;
      }
      const newAttributes = { ...EMPTY_ATTRIBUTES };
      for (const key of Object.keys(this.attributes)) {
        const index = TRACKED_ATTRIBUTES.indexOf(key);
        switch (typeof EMPTY_ATTRIBUTES[key]) {
          case "number":
            newAttributes[key] = Number(result[index]);
            break;
          case "boolean":
            newAttributes[key] = result[index] === "on";
            break;
          default:
            newAttributes[key] = result[index];
            break;
        }
      }
      this.updateTimestamp = Date.now();
      this.onUpdateAttributes(newAttributes);
      transaction?.resolve();
    } else if (error) {
      this.error(`Error returned for request [${id}]: ${JSON.stringify(error)}`);
      // reject any pending waits
      if (this.updateReject) {
        this.updateReject();
        this.updatePromisePending = false;
        delete this.updateResolve;
        delete this.updateReject;
      }
      transaction?.reject(error);
    } else {
      this.warn(`received unhandled ${id}:`, update);
      transaction?.resolve();
    }
  };

  private onUpdateAttributes = (newAttributes: Attributes) => {
    if (JSON.stringify(this.attributes) !== JSON.stringify(newAttributes)) {
      if (!this.config?.blocking) {
        this.services.forEach(service => service.onAttributesUpdated(newAttributes));
      }
      this.attributes = { ...newAttributes };
    }
  };

  private onDeviceConnected = async () => {
    this.connected = true;
    this.log(`${this.info.model} Connected`);
    this.requestAttributes();
    if (this.config.interval !== 0) {
      this.interval = setInterval(this.onInterval, this.config.interval || 60000);
    }
  };

  private onDeviceDisconnected = () => {
    if (this.connected) {
      this.connected = false;
      this.log("Disconnected");
      if (this.overrideConfig?.offOnDisconnect) {
        this.attributes.power = false;
        this.attributes.bg_power = false;
        this.log("configured to mark as powered-off when disconnected");
        this.services.forEach(service => service.onPowerOff());
      }
      if (this.updateReject) {
        this.updateReject();
        this.updatePromisePending = false;
      }
    }
    if (this.interval) {
      clearInterval(this.interval);
      delete this.interval;
    }
  };

  private onDeviceError = error => {
    this.log("Device Error", error);
  };

  connectDevice(device: Device) {
    device.connect();
    device.on("deviceUpdate", this.onDeviceUpdate);
    device.on("connected", this.onDeviceConnected);
    device.on("disconnected", this.onDeviceDisconnected);
    device.on("deviceError", this.onDeviceError);
  }

  // Respond to identify request
  identify(callback: () => void): void {
    this.log(`Hi ${this.info.model}`);
    callback();
  }

  setInfoService(override: OverrideLightConfiguration | undefined) {
    const { accessory, platform } = this;
    // set accessory information
    const infoService = this.accessory.getService(platform.Service.AccessoryInformation);
    let name = override?.name || this.specs.name;
    let count = nameCount.get(name) || 0;
    count = count + 1;
    nameCount.set(name, count);
    if (count > 1) {
      name = `${name} ${count}`;
    }
    if (!infoService) {
      const infoService = new platform.Service.AccessoryInformation();
      infoService
        .updateCharacteristic(platform.Characteristic.Manufacturer, "Yeelighter")
        .updateCharacteristic(platform.Characteristic.Model, this.specs.name)
        .updateCharacteristic(platform.Characteristic.Name, name)
        .updateCharacteristic(platform.Characteristic.SerialNumber, this.info.id)
        .updateCharacteristic(platform.Characteristic.FirmwareRevision, this.info.fw_ver);
      accessory.addService(infoService);
      return infoService;
    } else {
      // re-use service from cache
      infoService
        .updateCharacteristic(platform.Characteristic.Manufacturer, "Yeelighter")
        .updateCharacteristic(platform.Characteristic.Model, this.specs.name)
        .updateCharacteristic(platform.Characteristic.Name, name)
        .updateCharacteristic(platform.Characteristic.SerialNumber, this.info.id)
        .updateCharacteristic(platform.Characteristic.FirmwareRevision, this.info.fw_ver);
    }

    return infoService;
  }

  sendCommand(method: string, parameters: Array<string | number | boolean>) {
    if (!this.connected) {
      this.warn("send command but device doesn't seem connected");
    }
    const supportedCommands = this.device.info.support.split(",");
    if (!supportedCommands.includes) {
      this.warn(`sending ${method} although unsupported.`);
    }
    const id = this.lastCommandId + 1;
    if (this.detailedLogging) {
      this.log(`sendCommand(${id}, ${method}, ${JSON.stringify(parameters)})`);
    }
    this.device.sendCommand({ id, method, params: parameters });
    this.lastCommandId = id;
    return id;
  }

  async sendCommandPromise(method: string, parameters: Array<string | number | boolean>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const id = this.sendCommand(method, parameters);
      if (this.detailedLogging) {
        this.log(`sent command ${id}: ${method}`);
      }
      this.transactions.set(id, { resolve, reject, timestamp });
    });
  }

  private clearOldTransactions() {
    this.transactions.forEach((item, key) => {
      // clear transactions older than 60s
      if (item.timestamp > Date.now() + 60000) {
        this.log(`error: timeout for request ${key}`);
        item.reject(new Error("timeout"));
        this.transactions.delete(key);
      }
    });
  }

  private onInterval = () => {
    if (this.connected) {
      const updateSince = (Date.now() - this.updateTimestamp) / 1000;
      const updateThreshold = (this.config?.timeout || 5000) + (this.config?.interval || 60000) / 1000;
      if (this.updateTimestamp !== 0 && updateSince > updateThreshold) {
        this.log(`No update received within ${updateSince}s (Threshold: ${updateThreshold} (${this.config?.timeout}+${this.config?.interval}) => switching to unreachable`);
        this.connected = false;
      } else {
        this.requestAttributes();
      }
      //
    } else {
      if (this.interval) {
        clearInterval(this.interval);
        delete this.interval;
      }
    }
    this.clearOldTransactions();
  };

  async requestAttributes() {
    this.queryTimestamp = Date.now();
    this.sendCommandPromise("get_prop", this.device.info.trackedAttributes);
    this.log(`requesting attributes. Transactions: ${this.transactions.size}`);
  }


}
