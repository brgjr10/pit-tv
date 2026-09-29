/*
 * grouping.js — collapse the clips of one song into a single card.
 *
 * A show is a folder of clips, and a long show produces several takes of the
 * same song. Rendering each clip as its own card fills the grid with near
 * duplicates. Grouping happens at the render boundary only: search, filtering,
 * sorting, scoring and the facet counts all still run over entries, so matching
 * any clip surfaces the group and the existing relevance order is untouched.
 */

import { showKeyFor } from "./catalog.js";

/**
 * The key two clips must share to be one group.
 *
 * Null when the clip cannot join a group: no songId means it was never
 * identified with a song, and an untitled clip is a deliberate singleton (two
 * untitled clips of one show are far more likely to be two different songs
 * than two takes of one — the user groups them by giving them a title).
 */
function groupKeyFor(entry) {
  if (!entry || typeof entry.songId !== "string" || !entry.songId) return null;
  if (typeof entry.song !== "string" || !entry.song.trim()) return null;
  return { showId: showKeyFor(entry.id), songId: entry.songId, id: groupIdFor(entry) };
}

/** Group id, unique across the catalog: the show key joined to the song key. */
function groupIdFor(entry) {
  return showKeyFor(entry.id) + "~" + entry.songId;
}

/**
 * Collapse the ordered result of the query pipeline into renderable groups.
 *
 * A group is a synthetic entry: every field the views read is promoted from the
 * group's representative clip, plus `clips` (ordered) and `clipCount`. A group of
 * one is indistinguishable from a plain entry, so nothing downstream has to
 * special-case the common case.
 *
 * Group order follows first appearance, so relevance and sort order survive: a
 * group is placed where its first clip would have appeared.
 */
export function toGroups(entries) {
  const buckets = new Map();
  const out = [];
  const emitted = new Set();

  for (const entry of entries || []) {
    const key = groupKeyFor(entry);
    if (!key) {
      out.push(entry);
      continue;
    }

    const bucketKey = key.id;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { id: bucketKey, showId: key.showId, songId: key.songId, clips: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket.clips.push(entry);

    // Emitted once, at the position the group's first clip would have taken.
    if (!emitted.has(bucketKey)) {
      emitted.add(bucketKey);
      out.push(bucket);
    }
  }

  const groups = [];
  for (const item of out) {
    if (!item.clips) {
      groups.push(item);
      continue;
    }
    const made = makeGroup(item);
    // makeGroup returns an array only for the contradictory case, where the
    // bucket's clips are emitted individually rather than collapsed.
    if (Array.isArray(made)) groups.push(...made);
    else groups.push(made);
  }
  return groups;
}

/**
 * Build the synthetic entry for one bucket.
 *
 * The representative clip is the first in user order, and everything the views
 * read is promoted from it, so a card looks exactly like the clip it stands
 * for. `songs` is empty: a clip group is not a setlist.
 *
 * A group of one is returned as the entry itself rather than a wrapper, so a
 * single clip carries no badge, no reorder panel and no synthetic id.
 */
function makeGroup(bucket) {
  const clips = sortClips(bucket.clips);
  const rep = clips[0];
  if (clips.length < 2) return rep;

  // A clip that also declares a setlist is a contradictory state: it has a full
  // show AND its own clips. Rendering the setlist would drop the other clips
  // from the screen entirely, so the whole bucket is emitted ungrouped instead —
  // every clip keeps a card and the setlist still plays.
  //
  // Every clip is checked, not just the representative: the representative is
  // whichever clip sorts first, and a bucket where only a later clip carries the
  // setlist is exactly the case a rep-only check would miss, silently collapsing
  // the show into one card and throwing the setlist away.
  const withSetlist = clips.find((c) => c.songs?.length);
  if (withSetlist) {
    console.warn("[grouping] " + withSetlist.id + " has both clips and a songs setlist — rendering " + clips.length + " clips ungrouped");
    return clips;
  }

  return {
    ...rep,
    id: bucket.id,
    showId: bucket.showId,
    songId: bucket.songId,
    isGroup: true,
    clips,
    clipCount: clips.length,
    songs: [],
  };
}

/**
 * User order for a bucket: clipIndex first, with the current sort order as the
 * tie-break so equal indexes stay in the sequence the pipeline produced.
 */
function sortClips(clips) {
  return clips
    .map((clip, i) => ({ clip, i }))
    .sort((a, b) => {
      const ai = Number.isFinite(a.clip.clipIndex) ? a.clip.clipIndex : a.i;
      const bi = Number.isFinite(b.clip.clipIndex) ? b.clip.clipIndex : b.i;
      return ai === bi ? a.i - b.i : ai - bi;
    })
    .map((wrapped) => wrapped.clip);
}

/**
 * Playable rows for a group, in user order — the same shape setlistFor returns.
 *
 * A clip has no `title` field, but playableEntry() merges a row's `song` into
 * the show by that field, and the modal headline reads it too. Each row
 * therefore carries a shallow copy of its clip with `title` added — the clip's
 * own id, video, art and chapters are untouched, so resume positions, the
 * chapter rail and theming all resolve against the real clip.
 */
export function groupRowsFor(group) {
  if (!group?.clips?.length) return [];
  return group.clips.map((c) => ({ id: c.id, title: c.song || "Untitled", song: { ...c, title: c.song || "Untitled" } }));
}
