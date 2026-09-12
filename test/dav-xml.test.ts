import assert from 'node:assert/strict';
import { test } from 'node:test';
import { davHref, multistatus } from '../src/dav/xml.js';

test('davHref: trailing slash for collections, none for files, segments percent-encoded', () => {
  assert.equal(davHref([], true), '/dav/');
  assert.equal(davHref(['Movie & Friends'], true), '/dav/Movie%20%26%20Friends/');
  assert.equal(davHref(['Show', 'S01E01.mkv'], false), '/dav/Show/S01E01.mkv');
});

test('multistatus: escapes untrusted names, includes size/type for files only, one response per entry', () => {
  const xml = multistatus([
    { segments: [], collection: true, displayName: 'Debridarr library' },
    { segments: ['<script>&"\''], collection: true, displayName: '<script>&"\'' },
    { segments: ['a', 'movie.mkv'], collection: false, displayName: 'movie.mkv', bytes: 12345, contentType: 'video/x-matroska', lastModified: new Date('2024-01-01T00:00:00Z') },
  ]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?><D:multistatus xmlns:D="DAV:">/);
  assert.match(xml, /<\/D:multistatus>$/);
  assert.equal((xml.match(/<D:response>/g) ?? []).length, 3);
  assert.ok(!xml.includes('<script>'), 'a hostile name must not inject a raw element');
  assert.ok(xml.includes('&lt;script&gt;&amp;&quot;&apos;'));
  assert.ok(xml.includes('<D:getcontentlength>12345</D:getcontentlength>'));
  assert.ok(xml.includes('<D:getcontenttype>video/x-matroska</D:getcontenttype>'));
  assert.ok(xml.includes('<D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>'));
  assert.ok(xml.includes('<D:resourcetype><D:collection/></D:resourcetype>'), 'a folder is marked as a collection');
  assert.ok(xml.includes('<D:resourcetype></D:resourcetype>'), 'a file has an empty resourcetype');
  // A file entry must not also claim to be a collection or report a length for the root.
  assert.ok(!xml.includes('<D:getcontentlength>') || xml.match(/<D:getcontentlength>/g)!.length === 1);
});
