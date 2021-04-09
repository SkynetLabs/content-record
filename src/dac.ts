import { Buffer } from "buffer"
import { SkynetClient, MySky, JsonData } from "skynet-js";
import { ChildHandshake, Connection, WindowMessenger } from "post-me";
import { IContentInfo, IIndex, IPage, IContentPersistence, INewContentPersistence, EntryType, IDACResponse, IDictionary, IContentRecordDAC } from "./types";
import { cleanReferrer } from "./utils";

// consts
// const DATA_DOMAIN = "graio.hns"; // TODO: update to actual domain
const DATA_DOMAIN = "skynetbridge.hns"; // TODO: update to actual domain
const SKAPP_NAME = cleanReferrer(document.referrer);
const PAGE_REF = '[NUM]';

const ENTRY_MAX_SIZE = 1 << 12; // 4kib

// index consts
const INDEX_DEFAULT_PAGE_SIZE = 1000;
const INDEX_VERSION = 1;

// skapp dict path
const SKAPPS_DICT_PATH = `${DATA_DOMAIN}/skapps.json`

// new content paths
const NC_INDEX_PATH = `${DATA_DOMAIN}/${SKAPP_NAME}/newcontent/index.json`
const NC_PAGE_PATH = `${DATA_DOMAIN}/${SKAPP_NAME}/newcontent/page_[NUM].json`

// content interaction paths
const CI_INDEX_PATH = `${DATA_DOMAIN}/${SKAPP_NAME}/interactions/index.json`
const CI_PAGE_PATH = `${DATA_DOMAIN}/${SKAPP_NAME}/interactions/page_[NUM].json`

const urlParams = new URLSearchParams(window.location.search);
const dev = urlParams.get('dev') === "dev";

// ContentRecordDAC is a DAC that allows recording user interactions with pieces
// of content. There are two types of interactions which are:
// - content creation
// - content interaction (can be anything)
//
// The DAC will store these interactions across a fanout data structure that
// consists of an index file that points to multiple page files.
export default class ContentRecordDAC implements IContentRecordDAC {
  private mySky: MySky;
  private client: SkynetClient;
  private connection: Promise<Connection>;

  public constructor() {
    // create client
    this.client = new SkynetClient("https://siasky.net");

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
      methods
    );
  }

  public async init() {
    try {
      this.mySky = await this.client.loadMySky(DATA_DOMAIN, { dev })
    } catch (error) {
      console.log('Failed to load MySky, err: ', error)
      throw error;
    }
  }

  // onUserLogin is called by MySky when the user has logged in successfully
  public async onUserLogin() {
    // Ensure file hierarchy will ensure the index and current page file for
    // both entry types get precreated. This should alleviate a very slow
    // `getJSON` timeout on inserting the first entry.
    this.ensureFileHierarchy()
      .then(() => { console.log('Successfully ensured file hierarchy') })
      .catch(err => { console.log('Failed to ensure hierarchy, err: ', err) })

    // Register the skapp name in the dictionary
    this.registerSkappName()
      .then(() => { console.log('Successfully registered skappname') })
      .catch(err => { console.log('Failed to register skappname, err: ', err) })
  }

  // recordNewContent will record the new content creation in the content record
  public async recordNewContent(data: IContentInfo): Promise<IDACResponse> {
    try { 
      // purposefully not awaited
      this.handleNewEntry(EntryType.NEWCONTENT, data)
    } catch(error) {
      console.log('Error occurred trying to record new content, err: ', error)
    }
    return { submitted: true }
  }

  // recordInteraction will record a new interaction in the content record
  public async recordInteraction(data: IContentInfo): Promise<IDACResponse> {
    try {
      // purposefully not awaited
      this.handleNewEntry(EntryType.INTERACTIONS, data)
    } catch(error) {
      console.log('Error occurred trying to record interaction, err: ', error) 
    };
    return { submitted: true }
  }

  // registerSkappName is called on init and ensures this skapp name is
  // registered in the skapp name dictionary.
  private async registerSkappName() {
    let skapps = await this.downloadFile<IDictionary>(SKAPPS_DICT_PATH);
    if (!skapps) {
      skapps = {};
    }
    skapps[SKAPP_NAME] = true;
    await this.updateFile(SKAPPS_DICT_PATH, skapps);
  }

  // handleNewEntry is called by both 'recordNewContent' and 'recordInteraction'
  // and handles the given entry accordingly.
  private async handleNewEntry(kind: EntryType, data: IContentInfo) {
    const index = await this.fetchIndex(kind);
    let page = await this.fetchPage<IContentPersistence>(kind, index);
    page.entries.push(this.toPersistence(data));

    await this.updateFile(page.pagePath, page);
    await this.updateIndex(kind, index, page);
  }

  // updateIndex is called after a new entry got inserted and will update the
  // index to reflect this recently inserted entry.
  private async updateIndex(kind: EntryType, index: IIndex, page: IPage<INewContentPersistence>) { 
    const indexPath = kind === EntryType.NEWCONTENT
      ? NC_INDEX_PATH
      : CI_INDEX_PATH;
  
    const pagePath = kind === EntryType.NEWCONTENT
      ? NC_PAGE_PATH
      : CI_PAGE_PATH;
    
    index.currPageNumEntries = page.entries.length

    // rotate pages if necessary
    if (index.currPageNumEntries === INDEX_DEFAULT_PAGE_SIZE) {
      index.currPageNumber += 1
      const newPageNumStr = String(index.currPageNumber)
      const newPage = pagePath.replace(PAGE_REF, newPageNumStr);
      index.pages.push(newPage)
    }
    await this.updateFile(indexPath, index)
  }

  // fetchIndex downloads the index, if the index does not exist yet it will
  // return the default index.
  private async fetchIndex(kind: EntryType): Promise<IIndex> {
    const indexPath = kind === EntryType.NEWCONTENT
      ? NC_INDEX_PATH
      : CI_INDEX_PATH;
    
    const firstPagePath = kind === EntryType.NEWCONTENT
      ? NC_PAGE_PATH.replace(PAGE_REF, String(0))
      : CI_PAGE_PATH.replace(PAGE_REF, String(0));

    let index = await this.downloadFile<IIndex>(indexPath);
    if (!index) {
      index = {
        version: INDEX_VERSION,
        currPageNumber: 0,
        currPageNumEntries: 0,
        pages: [firstPagePath],
        pageSize: INDEX_DEFAULT_PAGE_SIZE,
      }
    }
    return index;
  }

  // fetchPage downloads the current page for given index, if the page does not
  // exist yet it will return the default page.
  private async fetchPage<T>(kind: EntryType, index: IIndex): Promise<IPage<T>> {
    const indexPath = kind === EntryType.NEWCONTENT
      ? NC_INDEX_PATH
      : CI_INDEX_PATH;

    const pagePath = kind === EntryType.NEWCONTENT
      ? NC_PAGE_PATH
      : CI_PAGE_PATH;
    
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
    }
    return page
  }

  // downloadFile merely wraps getJSON but is typed in a way that avoids
  // repeating the awkward "as unknown as T" everywhere
  private async downloadFile<T>(path: string): Promise<T | null> {
    console.log('downloading file at path', path)
    const { data } = await this.mySky.getJSON(path)
    if (!data) {
      console.log('no data found')
      return null;
    }
    console.log('data found', data)
    return data as unknown as T
  }

  // updateFile merely wraps setJSON but is typed in a way that avoids repeating
  // the awkwars "as unknown as JsonData" everywhere
  private async updateFile<T>(path: string, data: T) {
    console.log('updating file at path', path, data)
    await this.mySky.setJSON(path, data as unknown as JsonData)
  }

  // ensureFileHierarchy ensures that for every entry type its current index and
  // page file exist, this ensures we do not take the hit for it when the user
  // interacts with the DAC, seeing as non existing file requests time out only
  // after a certain amount of time.
  private async ensureFileHierarchy(): Promise<void> {
    for (const entryType of [EntryType.NEWCONTENT, EntryType.INTERACTIONS]) {
      const index = await this.fetchIndex(entryType)
      await this.fetchPage(entryType, index)
    }
  }

  // toPersistence turns content info into a content persistence object
  private toPersistence(data: IContentInfo): IContentPersistence {
    const persistence = {
      ...data,
      timestamp: Math.floor(Date.now() / 1000),
    }
    
    // validate the given data does not exceed max size
    const size = Buffer.from(JSON.stringify(persistence)).length
    if (size > ENTRY_MAX_SIZE) {
      throw new Error(`Entry exceeds max size, ${length}>${ENTRY_MAX_SIZE}`)
    }

    return persistence;
  }
}
