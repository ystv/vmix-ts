export type VMixCommand =
  | "TALLY"
  | "FUNCTION"
  | "ACTS"
  | "XML"
  | "XMLTEXT"
  | "SUBSCRIBE"
  | "UNSUBSCRIBE"
  | "QUIT";


export type InputType =
  | "Mix"
  | "Colour"
  | "VideoList"
  | "Video"
  | "Image"
  | "AudioFile"
  | "Title"
  | "Blank";

export interface BaseInput<T extends InputType = InputType> {
  key: string;
  type: T;
  number: number;
  title: string;
  shortTitle: string;
  state: string;
  position: number;
  duration: number;
  loop: boolean;
}

export interface ListItem {
  source: string;
  selected: boolean;
}

export interface ListInput extends BaseInput<"VideoList"> {
  selectedIndex: number;
  items: ListItem[];
}

export interface ColourInput extends BaseInput<"Colour"> {}

export interface BlankInput extends BaseInput<"Blank"> {}

export interface MixInput extends BaseInput<"Mix"> {}

export interface ImageInput extends BaseInput<"Image"> {}

export interface VideoInput extends BaseInput<"Video"> {
  muted: boolean;
  volume: number;
  balance: number;
  solo: boolean;
  audioBusses: unknown;
}

export interface AudioFileInput extends BaseInput<"AudioFile"> {
  muted: boolean;
  volume: number;
  balance: number;
  solo: boolean;
  audioBusses: unknown;
}

export type InputObject =
  | ListInput
  | ColourInput
  | MixInput
  | VideoInput
  | ImageInput
  | AudioFileInput
  | BlankInput;

export interface VMixState {
  version: string;
  edition: string;
  preset?: string;
  inputs: InputObject[];
}
