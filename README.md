# Content Record DAC

## Introduction

The content record DAC (Data Access Controller) allows recording users's
interactions with pieces of content. The main purpose of this DAC is content
discovery; if all skapps were to make use of this library, the end result would
be a scrapable global record of all content and the popularity of that content.

## Usage

Skapp developers can interact with the DAC using the Content Record Library. The
library itself is a simple class that acts as a wrapper around the Content
Record DAC. The library will contain a hardcoded reference to its domain, thus
abstracting all of its complexities from the skapp developer.

See https://github.com/SkynetHQ/content-record-library.

## Architecture

The DAC stores the content record entries accross a series of files that are
publicly discoverable. This makes it easy to scrape the content record. To
scrape you should only need the user's public key. From there you can predict
all of the files in which the content entries are stored by looking at some key
index files.

### FileSystem

The filesystem is fairly straightforward:

```
// keep track of all skapp names
contentrecord.hns/skapps.json

// keeps track of all new content entries
contentrecord.hns/myskapp.hns/newcontent/index.json
contentrecord.hns/myskapp.hns/newcontent/page_1.json
contentrecord.hns/myskapp.hns/newcontent/page_2.json
...

// keeps track of all content interaction entries
contentrecord.hns/myskapp.hns/interactions/index.json
contentrecord.hns/myskapp.hns/interactions/page_1.json
contentrecord.hns/myskapp.hns/interactions/page_2.json
...

```

#### Skapp Dictionary

At the data domain's root there's a `skapps.json` file that contains a
dictionary of skapp names. Whenever the DAC is initialised, it will register the
referring skapp in this dictionary. This is useful for scraping purposes, as it
essentially enables a scraper to build all of the filepaths to the index files.

#### Content Index & Pages

Entries are recorded in the DAC as two separate types. It's either a new content
entry, or a content interaction entry. This separation is reflected in the file
structure as well.

The content files work using a fanout-type mechanims, where the index file
contains references to page files, which in turn contain the entries themselves.
The pages are limited in size to contain 1000 entries per page, each entry being
4kib in size maximum.

### Types

The data structures used by the Content Record DAC are self-explanatory for the
most part. It is a fanout-type data structure where index files point to page
files. The files themselves contain offsets, making it possible to only read the
index file to know exactly how many entries are currently contained within all
of the pages. The dictionary is a simple map.

```typescript
export interface IIndex {
  version: number;

  currPageNumber: number;
  currPageNumEntries: number;

  pages: string[];
  pageSize: number;
}

export interface IPage<IEntry> {
  version: number;

  indexPath: string; // back reference to the index, not used currently
  pagePath: string; // back reference to the path, not used currently

  entries: IEntry[];
}

export interface IDictionary<T> {
  [key: string]: T;
}
```
