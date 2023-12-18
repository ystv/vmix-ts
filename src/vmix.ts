import { Socket, connect } from "node:net";
import { XMLParser } from "fast-xml-parser";
import { AudioFileInput, BaseInput, InputObject, InputType, ListInput, VMixCommand, VMixState, VideoInput } from "./vmixTypes";
import { v4 as uuidV4 } from "uuid";
import { AudioFileObject, VMixRawXMLSchema, VideoListObject, VideoObject } from "./vmixTypesRaw";
import qs from "qs";
import { z } from "zod";
import { invariant } from "./invariant";

interface ReqQueueItem {
  command: VMixCommand;
  args: string[];
  resolve: (msgAndData: [string, string]) => void;
  reject: (err: Error) => void;
}

export interface VMixConnectionSettings {
  stateSchemaMismatchMode: "ignore" | "log" | "error";
}

/**
 * A connection to a vMix instance using the TCP API.
 *
 * @example
 *   const vmix = await VMixConnection.connect();
 */
export default class VMixConnection {
  private sock!: Socket;
  private settings!: VMixConnectionSettings;

  // See the comment on doNextRequest for an explanation of this.
  private replyAwaiting: Map<
    VMixCommand,
    {
      resolve: (msgAndData: [string, string]) => void;
      reject: (err: Error) => void;
    }
  >;
  private requestQueue: Array<ReqQueueItem> = [];

  private buffer: string = "";
  private xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  });
  private constructor(
    // This is only used for display purposes, the actual connection is established in `connect()`,
    // before this constructor is called.
    public readonly host: string,
    public readonly port: number,
  ) {
    this.replyAwaiting = new Map();
  }

  public static async connect({host = "localhost", port = 8099, settings}: { host?: string, port?: number, settings?: Partial<VMixConnectionSettings>  } = {}) {
    const sock = connect({
      host,
      port,
    });
    sock.setEncoding("utf-8");
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => {
        sock.off("error", reject);
        resolve();
      });
      sock.on("error", reject);
    });
    const vmix = new VMixConnection(host, port);
    vmix.settings = {
      stateSchemaMismatchMode: settings?.stateSchemaMismatchMode ?? "log",
    };
    vmix.sock = sock;
    sock.on("data", vmix.onData.bind(vmix));
    sock.on("close", vmix.onClose.bind(vmix));
    sock.on("error", vmix.onError.bind(vmix));
    return vmix;
  }

  public async addInput(type: InputType, filePath: string) {
    // vMix doesn't return the input key, but you can pass it one to use.
    const id = uuidV4();
    await this.doFunction("AddInput", {
      Value: type + "|" + filePath,
      Input: id,
    });
    // This may error if the input is already added or the GUID collides (very unlikely)
    return id;
  }

  public async renameInput(inputKey: string, newName: string) {
    await this.doFunction("SetInputName", { Input: inputKey, Value: newName });
  }

  public async addInputToList(listSource: string, path: string) {
    await this.doFunction("ListAdd", { Input: listSource, Value: path });
  }

  /**
   *
   * @param listSource the name, index, or ID of the list source
   * @param index the index of the item to remove - NB: this is 1-based!
   */
  public async removeItemFromList(listSource: string, index: number) {
    await this.doFunction("ListRemove", {
      Input: listSource,
      Value: index.toString(),
    });
  }

  public async clearList(listSource: string) {
    await this.doFunction("ListRemoveAll", { Input: listSource });
  }

  // Function reference: https://www.vmix.com/help26/ShortcutFunctionReference.html
  private async doFunction(fn: string, params: Record<string, string>) {
    return this.send("FUNCTION", fn, qs.stringify(params));
  }

  public async getFullStateRaw(): Promise<unknown> {
    const res = await this.send("XML");
    return this.xmlParser.parse(res[1]);
  }

  public async getFullState(): Promise<VMixState> {
    const data = await this.getFullStateRaw();
    const rawParseRes = VMixRawXMLSchema.safeParse(data);
    let raw: z.infer<typeof VMixRawXMLSchema>;
    if (rawParseRes.success) {
      raw = rawParseRes.data;
    } else {
      switch (this.settings.stateSchemaMismatchMode) {
        case "ignore":
          // DIRTY HACK - assume that the data matches the schema to extract what we can
          raw = data as z.infer<typeof VMixRawXMLSchema>;
          break;
        case "log":
          console.warn("Parsing raw vMix schema failed. This is a bug, please report it at https://github.com/ystv/vmix-ts/issues.");
          console.warn(rawParseRes.error);
          console.warn("Raw data:", JSON.stringify(data));
          // DIRTY HACK - assume that the data matches the schema to extract what we can
          raw = data as z.infer<typeof VMixRawXMLSchema>;
          break;
        case "error":
          throw new Error(
            "Parsing raw vMix schema failed. This is a bug, please report it at https://github.com/ystv/vmix-ts/issues.",
            { cause: rawParseRes.error }
          );
      }
    }
    const res: VMixState = {
      version: raw.vmix.version,
      edition: raw.vmix.edition,
      preset: raw.vmix.preset,
      inputs: [],
    };
    for (const input of raw.vmix.inputs.input) {
      // eslint is wrong
      // eslint-disable-next-line prefer-const
      let v: BaseInput = {
        key: input["@_key"],
        number: input["@_number"],
        type: input["@_type"] as InputType,
        title: input["@_title"],
        shortTitle: input["@_shortTitle"],
        loop: input["@_loop"] === "True",
        state: input["@_state"],
        duration: input["@_duration"],
        position: input["@_position"],
      };
      switch (input["@_type"]) {
        case "Colour":
        case "Mix":
        case "Image":
        case "Blank":
          break;
        case "Video":
        case "AudioFile": {
          const r = input as VideoObject | AudioFileObject;
          (v as unknown as VideoInput | AudioFileInput) = {
            ...v,
            type: r["@_type"] as "Video" | "AudioFile",
            volume: r["@_volume"],
            balance: r["@_balance"],
            solo: r["@_solo"] === "True",
            muted: r["@_muted"] === "True",
            audioBusses: r["@_audiobusses"],
          };
          break;
        }
        case "VideoList": {
          const r = input as VideoListObject;
          (v as unknown as ListInput) = {
            ...v,
            type: r["@_type"],
            selectedIndex: r["@_selectedIndex"] - 1 /* 1-based index */,
            items: [],
          };
          if (Array.isArray(r.list?.item)) {
            (v as ListInput).items = r.list!.item.map((item) => {
              if (typeof item === "string") {
                return {
                  source: item,
                  selected: false,
                };
              }
              return {
                source: item["#text"],
                selected: item["@_selected"] === "true",
              };
            });
          } else if (r.list) {
            (v as ListInput).items.push({
              source: r.list.item["#text"],
              selected: r.list.item["@_selected"] === "true",
            });
          }
          break;
        }
        default:
          switch (this.settings.stateSchemaMismatchMode) {
            case "ignore":
              break;
            case "log":
              console.warn(`Unknown input type ${input["@_type"]}. This is a bug, please report it at https://github.com/ystv/vmix-ts/issues.`);
              break;
            case "error":
              throw new Error(`Unknown input type ${input["@_type"]}. This is a bug, please report it at https://github.com/ystv/vmix-ts/issues.`);
          }
          continue;
      }
      res.inputs.push(v as InputObject);
    }
    return res;
  }

  private async send(command: VMixCommand, ...args: string[]) {
    const req: ReqQueueItem = {
      command,
      args,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reject: null as any,
    };
    const reply = new Promise<[string, string]>((resolve, reject) => {
      req.resolve = resolve;
      req.reject = reject;
    });
    this.requestQueue.push(req);
    await this.doNextRequest();
    return reply;
  }

  // When replying to a TCP request, vMix includes the name of the command
  // in its response, but nothing else that would allow us to identify the sender
  // (unlike e.g. the OBS WebSocket API, where requests can have an ID).
  // Therefore, we only allow one request per command type to be in flight at
  // a time.
  //
  // The replyAwaiting map tracks whether we have sent a request for a given command,
  // and therefore we can't send another until we've received a response to the first.
  // If a request of type X is added to the queue when there is already one in flight,
  // doNextRequest will skip processing it. Then, once a compelte response is received
  // by onData(), it will call doNextRequest again to process the next request.
  //
  // This implementation is a bit simplistic - if the first request in the queue
  // is blocked we won't process any others, even if they would not be blocked.
  // However, this is unlikely to be a problem in practice.
  //
  // TODO: With that in mind, this could be simplified even further - instead of a
  // replyAwaiting map, we could just have a single boolean flag indicating whether
  // a request is in flight.
  private async doNextRequest() {
    const req = this.requestQueue[0];
    if (!req) {
      return;
    }
    if (this.replyAwaiting.has(req.command)) {
      // Wait until the next run
      return;
    }
    this.requestQueue.shift();
    this.replyAwaiting.set(req!.command, req!);
    await new Promise<void>((resolve, reject) => {
      this.sock.write(
        req.command +
          (req.args.length > 0 ? " " + req.args.join(" ") : "") +
          "\r\n",
        "utf-8",
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  private onData(data: Buffer) {
    this.buffer += data.toString();
    // Replies will be in one of the following forms:
    //
    //MYCOMMAND OK This is the response to MYCOMMAND\r\n
    //
    //MYCOMMAND ER This is an error message in response to MYCOMMAND\r\n
    //
    //MYCOMMAND 28\r\n
    //This is optional binary data
    //
    //MYCOMMAND 28 This is a message in addition to the binary data\r\n
    //This is optional binary data
    //
    // The 28 in the last two examples is the length of the binary data.
    // NB: binary data doesn't necessarily end with \r\n!

    if (!this.buffer.includes("\r\n")) {
      return;
    }
    const firstLine = this.buffer.slice(0, this.buffer.indexOf("\r\n"));
    const [command, status, ...rest] = firstLine.split(" ");
    const reply = this.replyAwaiting.get(command as VMixCommand);
    if (status === "OK") {
      reply?.resolve([rest.join(" "), ""]);
      this.replyAwaiting.delete(command as VMixCommand);
      this.buffer = "";
      process.nextTick(this.doNextRequest.bind(this));
      return;
    }
    if (status === "ER") {
      reply?.reject(new Error(rest.join(" ")));
      this.replyAwaiting.delete(command as VMixCommand);
      this.buffer = "";
      process.nextTick(this.doNextRequest.bind(this));
      return;
    }
    // This is a binary response and "status" is actually its length
    invariant(status.match(/^\d+$/), "Invalid status: " + status);
    const payloadLength = parseInt(status, 10);
    // +2 for the \r\n
    if (this.buffer.length < payloadLength + firstLine.length + 2) {
      // still need more data
      return;
    }
    const payload = this.buffer.slice(
      firstLine.length + 2,
      payloadLength + firstLine.length + 2,
    );
    reply?.resolve([rest.join(" "), payload.trim()]);
    this.replyAwaiting.delete(command as VMixCommand);
    process.nextTick(this.doNextRequest.bind(this));
    this.buffer = "";
  }

  private onClose() {
    this.replyAwaiting.forEach((req) => req.reject(new Error("Socket closed")));
    this.replyAwaiting.clear();
    this.requestQueue.forEach((req) => req.reject(new Error("Socket closed")));
    this.requestQueue = [];
    this.onError(new Error("Socket closed"));
  }

  private onError(err: Error) {
    // TODO expose as callback
    console.error("VMix connection error", err);
  }
}