
export interface IContentRecordDAC {
  recordNewContent(content: IContentInfo): Promise<IDACResponse>;
  recordInteraction(content: IContentInfo): Promise<IDACResponse>;
}

export interface IContentInfo {
  skylink: string;    // skylink
  metadata: object;   // should be valid JSON
}

export interface IContentPersistence {
  timestamp: number;  // unix timestamp of recording
}

export interface INewContentPersistence extends IContentPersistence { }
export interface IInteractionPersistence extends IContentPersistence { }

export interface IIndex {
  version: number;

  currPageNumber: number;
  currPageNumEntries: number;

  pages: string[];
  pageSize: number;
}

export interface IPage<IEntry> {
  version: number;

  indexPath: string; // back reference to the index
  pagePath: string; // back reference to the path

  entries: IEntry[];
}

export interface IDictionary<T> {
  [key:string]: T
}
export interface IDACResponse {
  submitted: boolean;
  error?: string;
}

export enum EntryType {
  'NEWCONTENT',
  'INTERACTIONS'
}

// NOTE: the values contained by this interface are 'static', meaning they won't
// change after the DAC has initialized. That is why they are uppercased,
// because desctructured they will look like regular constants.
//
// e.g. const { NC_INDEX_PATH } = this.paths;
export interface IFilePaths {
  SKAPPS_DICT_PATH: string;

  NC_INDEX_PATH: string;
  NC_PAGE_PATH: string;

  CI_INDEX_PATH: string;
  CI_PAGE_PATH: string;
}
    