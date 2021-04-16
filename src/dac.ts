import { Buffer } from "buffer"
import { SkynetClient, MySky, JsonData } from "skynet-js";
import { ChildHandshake, Connection, WindowMessenger } from "post-me";
import { IContentInfo, IIndex, IPage, IContentPersistence, INewContentPersistence, EntryType, IDACResponse, IDictionary, IContentRecordDAC, IFilePaths } from "./types";

// DAC consts
const DATA_DOMAIN = "crqa.hns";

const urlParams = new URLSearchParams(window.location.search);
const DEBUG_ENABLED = urlParams.get('debug') === "true";
const DEV_ENABLED = urlParams.get('dev') === "true";

// page consts
const ENTRY_MAX_SIZE = 1 << 12; // 4kib
const PAGE_REF = '[NUM]';

// index consts
const INDEX_DEFAULT_PAGE_SIZE = 1000;
const INDEX_VERSION = 1;

// ContentRecordDAC is a DAC that allows recording user interactions with pieces
// of content. There are two types of interactions which are:
// - content creation
// - content interaction (can be anything)
//
// The DAC will store these interactions across a fanout data structure that
// consists of an index file that points to multiple page files.
export default class ContentRecordDAC implements IContentRecordDAC {
  protected connection: Promise<Connection>;

  private client: SkynetClient
  private mySky: MySky;
  private paths: IFilePaths;
  private skapp: string;

  public constructor(
  ) {
    // create client
    this.client = new SkynetClient();

    // define API
    const methods = {
      init: this.init.bind(this),
      onUserLogin: this.onUserLogin.bind(this),
      recordNewContent: this.recordNewContent.bind(this),
      recordInteraction: this.recordInteraction.bind(this),
    };

    // create connection
    this.connection = ChildHandshake(
      new WindowMessenger({
        localWindow: window,
        remoteWindow: window.parent,
        remoteOrigin: "*",
      }),
      methods,
    );
  }

  public async init() {
    try {
      // extract the skappname and use it to set the filepaths
      const hostname = new URL(document.referrer).hostname
      const skapp = await this.client.extractDomain(hostname)
      this.log("loaded from skapp", skapp)
      this.skapp = skapp;

      this.paths = {
        SKAPPS_DICT_PATH: `${DATA_DOMAIN}/skapps.json`,
        NC_INDEX_PATH: `${DATA_DOMAIN}/${skapp}/newcontent/index.json`,
        NC_PAGE_PATH: `${DATA_DOMAIN}/${skapp}/newcontent/page_[NUM].json`,
        CI_INDEX_PATH: `${DATA_DOMAIN}/${skapp}/interactions/index.json`,
        CI_PAGE_PATH: `${DATA_DOMAIN}/${skapp}/interactions/page_[NUM].json`,
      }

      // load mysky
      const opts = { dev: DEV_ENABLED }
      this.mySky = await this.client.loadMySky(DATA_DOMAIN, opts)
    } catch (error) {
      this.log('Failed to load MySky, err: ', error)
      throw error;
    }
  }

  // onUserLogin is called by MySky when the user has logged in successfully
  public async onUserLogin() {
    // Ensure file hierarchy will ensure the index and current page file for
    // both entry types get precreated. This should alleviate a very slow
    // `getJSON` timeout on inserting the first entry.
    this.ensureFileHierarchy()
      .then(() => { this.log('Successfully ensured file hierarchy') })
      .catch(err => { this.log('Failed to ensure hierarchy, err: ', err) })

    // Register the skapp name in the dictionary
    this.registerSkappName()
      .then(() => { this.log('Successfully registered skappname') })
      .catch(err => { this.log('Failed to register skappname, err: ', err) })
  }

  // recordNewContent will record the new content creation in the content record
  public async recordNewContent(...data: IContentInfo[]): Promise<IDACResponse> {
    try {
      // purposefully not awaited
      this.handleNewEntries(EntryType.NEWCONTENT, ...data)
    } catch (error) {
      this.log('Error occurred trying to record new content, err: ', error)
    }
    return { submitted: true }
  }

  // recordInteraction will record a new interaction in the content record
  public async recordInteraction(...data: IContentInfo[]): Promise<IDACResponse> {
    try {
      // purposefully not awaited
      this.handleNewEntries(EntryType.INTERACTIONS, ...data)
    } catch (error) {
      this.log('Error occurred trying to record interaction, err: ', error)
    };
    return { submitted: true }
  }

  // registerSkappName is called on init and ensures this skapp name is
  // registered in the skapp name dictionary.
  private async registerSkappName() {
    const { SKAPPS_DICT_PATH } = this.paths;
    let skapps = await this.downloadFile<IDictionary>(SKAPPS_DICT_PATH);
    if (!skapps) {
      skapps = {};
    }
    skapps[this.skapp] = true;
    await this.updateFile(SKAPPS_DICT_PATH, skapps);
  }

  // handleNewEntries is called by both 'recordNewContent' and
  // 'recordInteraction' and handles the given entry accordingly.
  private async handleNewEntries(kind: EntryType, ...data: IContentInfo[]) {
    let index = await this.fetchIndex(kind);
    let page = await this.fetchPage<IContentPersistence>(kind, index);

    let entriesAddedToPage = 0;
    for (const entry of data) {
      let persistence: IContentPersistence;
      try {
        persistence = this.toPersistence(entry);
      } catch (error) {
        this.log("Failed to transform entry to persistence object", error)
        continue;
      }

      page.entries.push(persistence);
      entriesAddedToPage++;
      if (page.entries.length === INDEX_DEFAULT_PAGE_SIZE) {
        // TODO: optimize performance
        await this.updateFile(page.pagePath, page);
        index = await this.updateIndex(kind, index, page);
        page = await this.fetchPage<IContentPersistence>(kind, index);
        entriesAddedToPage = 0;
      }
    }

    if (entriesAddedToPage) {
      await Promise.all([
        this.updateFile(page.pagePath, page),
        this.updateIndex(kind, index, page)
      ]);
    }
  }

  // updateIndex is called after a new entry got inserted and will update the
  // index to reflect this recently inserted entry.
  private async updateIndex(kind: EntryType, index: IIndex, page: IPage<INewContentPersistence>): Promise<IIndex> {
    const indexPath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_INDEX_PATH
      : this.paths.CI_INDEX_PATH;

    const pagePath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_PAGE_PATH
      : this.paths.CI_PAGE_PATH;

    index.currPageNumEntries = page.entries.length

    // rotate pages if necessary
    if (index.currPageNumEntries === INDEX_DEFAULT_PAGE_SIZE) {
      index.currPageNumber += 1
      const newPageNumStr = String(index.currPageNumber)
      const newPage = pagePath.replace(PAGE_REF, newPageNumStr);
      index.pages.push(newPage)
    }
    await this.updateFile(indexPath, index)
    return index;
  }

  // fetchIndex downloads the index, if the index does not exist yet it will
  // return the default index.
  private async fetchIndex(kind: EntryType, updateIfNotExists: boolean = false): Promise<IIndex> {
    const indexPath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_INDEX_PATH
      : this.paths.CI_INDEX_PATH;

    const firstPagePath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_PAGE_PATH.replace(PAGE_REF, String(0))
      : this.paths.CI_PAGE_PATH.replace(PAGE_REF, String(0));

    let index = await this.downloadFile<IIndex>(indexPath);
    if (!index) {
      index = {
        version: INDEX_VERSION,
        currPageNumber: 0,
        currPageNumEntries: 0,
        pages: [firstPagePath],
        pageSize: INDEX_DEFAULT_PAGE_SIZE,
      }
      if (updateIfNotExists) {
        await this.updateFile(indexPath, index)
      }
    }
    return index;
  }

  // fetchPage downloads the current page for given index, if the page does not
  // exist yet it will return the default page.
  private async fetchPage<T>(kind: EntryType, index: IIndex, updateIfNotExists: boolean = false): Promise<IPage<T>> {
    const indexPath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_INDEX_PATH
      : this.paths.CI_INDEX_PATH;

    const pagePath = kind === EntryType.NEWCONTENT
      ? this.paths.NC_PAGE_PATH
      : this.paths.CI_PAGE_PATH;

    const currPageStr = String(index.currPageNumber)
    const currPagePath = pagePath.replace(PAGE_REF, currPageStr);

    let page = await this.downloadFile<IPage<T>>(currPagePath);
    if (!page) {
      page = {
        version: INDEX_VERSION,
        indexPath,
        pagePath: currPagePath,
        entries: [],
      }
      if (updateIfNotExists) {
        await this.updateFile(currPagePath, page);
      }
    }
    return page
  }

  // downloadFile merely wraps getJSON but is typed in a way that avoids
  // repeating the awkward "as unknown as T" everywhere
  private async downloadFile<T>(path: string): Promise<T | null> {
    this.log('downloading file at path', path)
    const { data } = await this.mySky.getJSON(path)
    if (!data) {
      this.log('no data found at path', path)
      return null;
    }
    this.log('data found at path', path, data)
    return data as unknown as T
  }

  // updateFile merely wraps setJSON but is typed in a way that avoids repeating
  // the awkwars "as unknown as JsonData" everywhere
  private async updateFile<T>(path: string, data: T) {
    this.log('updating file at path', path, data)
    await this.mySky.setJSON(path, data as unknown as JsonData)
  }

  // ensureFileHierarchy ensures that for every entry type its current index and
  // page file exist, this ensures we do not take the hit for it when the user
  // interacts with the DAC, seeing as non existing file requests time out only
  // after a certain amount of time.
  private async ensureFileHierarchy(): Promise<void> {
    const updateIfNotExists = true;
    for (const entryType of [EntryType.NEWCONTENT, EntryType.INTERACTIONS]) {
      const index = await this.fetchIndex(entryType, updateIfNotExists)
      await this.fetchPage(entryType, index, updateIfNotExists)
    }
  }

  // toPersistence turns content info into a content persistence object
  private toPersistence(data: IContentInfo): IContentPersistence {
    const persistence = {
      timestamp: Math.floor(Date.now() / 1000),
      ...data,
    }

    if (persistence.metadata === undefined) {
      persistence.metadata = {};
    }

    // validate the given data does not exceed max size
    const size = Buffer.from(JSON.stringify(persistence)).length
    if (size > ENTRY_MAX_SIZE) {
      throw new Error(`Entry exceeds max size, ${length}>${ENTRY_MAX_SIZE}`)
    }

    return persistence;
  }

  // log prints to stdout only if DEBUG_ENABLED flag is set
  private log(message: string, ...optionalContext: any[]) {
    if (DEBUG_ENABLED) {
      console.log(message, ...optionalContext)
    }
  }
}
