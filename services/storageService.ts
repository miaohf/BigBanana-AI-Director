import { ProjectState, AssetLibraryItem, SeriesProject, Series, Episode } from '../types';
import { runV2ToV3Migration, runEpisodeTitleFixMigration } from './migrationService';
import { materializeProjectVideosForExport, migrateProjectVideosToOPFS } from './videoStorageService';
import { reconcileShotSceneIds } from './storyboardIdUtils';
import { sanitizePromptTemplateOverrides } from './promptTemplateService';
import { normalizeChatModelId } from './modelIdUtils';
import { getConfiguredChatModelId, resolveShotGenerationModel } from './modelRegistry';

const DB_NAME = 'BigBananaDB';
const DB_VERSION = 3;
const STORE_NAME = 'projects';
const ASSET_STORE_NAME = 'assetLibrary';
const SP_STORE = 'seriesProjects';
const SERIES_STORE = 'series';
const EP_STORE = 'episodes';
const EXPORT_SCHEMA_VERSION = 3;

export interface IndexedDBExportPayload {
  schemaVersion: number;
  exportedAt: number;
  scope?: 'all' | 'project' | 'episode';
  dbName: string;
  dbVersion: number;
  stores: {
    projects: ProjectState[];
    assetLibrary: AssetLibraryItem[];
    seriesProjects?: SeriesProject[];
    series?: Series[];
    episodes?: Episode[];
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

const normalizeStoredChatModel = (modelId?: string): string => {
  return resolveShotGenerationModel(modelId);
};

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      runV2ToV3Migration(db)
        .then(() => runEpisodeTitleFixMigration(db))
        .then(() => resolve(db))
        .catch((e) => { console.error('Migration error (non-fatal):', e); resolve(db); });
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE_NAME)) {
        db.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SP_STORE)) {
        db.createObjectStore(SP_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SERIES_STORE)) {
        const ss = db.createObjectStore(SERIES_STORE, { keyPath: 'id' });
        ss.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(EP_STORE)) {
        const es = db.createObjectStore(EP_STORE, { keyPath: 'id' });
        es.createIndex('projectId', 'projectId', { unique: false });
        es.createIndex('seriesId', 'seriesId', { unique: false });
      }
    };
  });

  return dbPromise;
};

const mergeByKey = <T>(
  existing: T[] | undefined,
  inferred: T[],
  getKey: (item: T) => string
): T[] => {
  const merged = new Map<string, T>();
  inferred.forEach(item => merged.set(getKey(item), item));
  (existing || []).forEach(item => merged.set(getKey(item), item));
  return Array.from(merged.values());
};

const normalizeEpisode = (ep: Episode): Episode => {
  const scriptData = ep.scriptData
    ? {
        ...ep.scriptData,
        props: ep.scriptData.props || [],
      }
    : null;

  const inferredCharacterRefs = (scriptData?.characters || [])
    .filter(c => !!c.libraryId)
    .map(c => ({
      characterId: c.libraryId!,
      syncedVersion: c.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredSceneRefs = (scriptData?.scenes || [])
    .filter(s => !!s.libraryId)
    .map(s => ({
      sceneId: s.libraryId!,
      syncedVersion: s.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredPropRefs = (scriptData?.props || [])
    .filter(p => !!p.libraryId)
    .map(p => ({
      propId: p.libraryId!,
      syncedVersion: p.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  return {
    ...ep,
    shotGenerationModel: normalizeStoredChatModel(ep.shotGenerationModel),
    scriptData,
    shots: reconcileShotSceneIds(ep.shots || [], scriptData?.scenes || []),
    renderLogs: ep.renderLogs || [],
    characterRefs: mergeByKey(ep.characterRefs, inferredCharacterRefs, r => r.characterId),
    sceneRefs: mergeByKey(ep.sceneRefs, inferredSceneRefs, r => r.sceneId),
    propRefs: mergeByKey(ep.propRefs, inferredPropRefs, r => r.propId),
    promptTemplateOverrides: sanitizePromptTemplateOverrides(ep.promptTemplateOverrides),
  };
};

const normalizeAndPersistEpisodeVideos = async (ep: Episode): Promise<Episode> => {
  const normalized = normalizeEpisode(ep);
  try {
    const { project } = await migrateProjectVideosToOPFS(normalized);
    return project as Episode;
  } catch (error) {
    console.warn('Normalize episode video storage failed, use original episode data.', error);
    return normalized;
  }
};

// =============================================
// SeriesProject CRUD
// =============================================

export const saveSeriesProject = async (sp: SeriesProject): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readwrite');
    tx.objectStore(SP_STORE).put({ ...sp, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const loadSeriesProject = async (id: string): Promise<SeriesProject> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readonly');
    const req = tx.objectStore(SP_STORE).get(id);
    req.onsuccess = () => {
      if (req.result) resolve(req.result as SeriesProject);
      else reject(new Error('SeriesProject not found'));
    };
    req.onerror = () => reject(req.error);
  });
};

export const getAllSeriesProjects = async (): Promise<SeriesProject[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SP_STORE, 'readonly');
    const req = tx.objectStore(SP_STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result as SeriesProject[]) || [];
      items.sort((a, b) => b.lastModified - a.lastModified);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteSeriesProject = async (id: string): Promise<void> => {
  const db = await openDB();

  const seriesList = await getSeriesByProject(id);
  const episodes = await getEpisodesByProject(id);

  return new Promise((resolve, reject) => {
    const stores = [SP_STORE, SERIES_STORE, EP_STORE];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(SP_STORE).delete(id);
    for (const s of seriesList) tx.objectStore(SERIES_STORE).delete(s.id);
    for (const ep of episodes) tx.objectStore(EP_STORE).delete(ep.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewSeriesProject = (title?: string): SeriesProject => {
  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timePart = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const autoTitle = `新建项目 ${datePart} ${timePart}`;
  const finalTitle = title?.trim() || autoTitle;

  return {
    id: 'sproj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: finalTitle,
    createdAt: Date.now(),
    lastModified: Date.now(),
    visualStyle: '3d-animation',
    language: '中文',
    characterLibrary: [],
    sceneLibrary: [],
    propLibrary: [],
  };
};

// =============================================
// Series CRUD
// =============================================

export const saveSeries = async (s: Series): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SERIES_STORE, 'readwrite');
    tx.objectStore(SERIES_STORE).put({ ...s, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getSeriesByProject = async (projectId: string): Promise<Series[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SERIES_STORE, 'readonly');
    const idx = tx.objectStore(SERIES_STORE).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      const items = (req.result as Series[]) || [];
      items.sort((a, b) => a.sortOrder - b.sortOrder);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteSeries = async (id: string): Promise<void> => {
  const db = await openDB();
  const eps = await getEpisodesBySeries(id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SERIES_STORE, EP_STORE], 'readwrite');
    tx.objectStore(SERIES_STORE).delete(id);
    for (const ep of eps) tx.objectStore(EP_STORE).delete(ep.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewSeries = (projectId: string, title: string, sortOrder: number): Series => {
  return {
    id: 'series_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    sortOrder,
    createdAt: Date.now(),
    lastModified: Date.now(),
  };
};

// =============================================
// Episode CRUD
// =============================================

export const saveEpisode = async (ep: Episode): Promise<void> => {
  const normalized = await normalizeAndPersistEpisodeVideos(ep);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readwrite');
    tx.objectStore(EP_STORE).put({ ...normalized, lastModified: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const loadEpisode = async (id: string): Promise<Episode> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const req = tx.objectStore(EP_STORE).get(id);
    req.onsuccess = () => {
      if (req.result) {
        const normalized = normalizeEpisode(req.result as Episode);
        void (async () => {
          try {
            const { project: migrated, changed } = await migrateProjectVideosToOPFS(normalized);
            const migratedEpisode = migrated as Episode;
            if (changed) {
              void saveEpisode(migratedEpisode).catch(error => {
                console.warn('Persist OPFS migration for episode failed.', error);
              });
            }
            resolve(migratedEpisode);
          } catch (error) {
            console.warn('Episode OPFS migration failed, fallback to original episode data.', error);
            resolve(normalized);
          }
        })();
      } else reject(new Error('Episode not found'));
    };
    req.onerror = () => reject(req.error);
  });
};

export const getEpisodesByProject = async (projectId: string): Promise<Episode[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const idx = tx.objectStore(EP_STORE).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      const items = ((req.result as Episode[]) || []).map(normalizeEpisode);
      items.sort((a, b) => a.episodeNumber - b.episodeNumber);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const getEpisodesBySeries = async (seriesId: string): Promise<Episode[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const idx = tx.objectStore(EP_STORE).index('seriesId');
    const req = idx.getAll(seriesId);
    req.onsuccess = () => {
      const items = ((req.result as Episode[]) || []).map(normalizeEpisode);
      items.sort((a, b) => a.episodeNumber - b.episodeNumber);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteEpisode = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readwrite');
    tx.objectStore(EP_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const createNewEpisode = (projectId: string, seriesId: string, episodeNumber: number, title?: string): Episode => {
  return {
    id: 'ep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    seriesId,
    episodeNumber,
    title: title || `第 ${episodeNumber} 集`,
    createdAt: Date.now(),
    lastModified: Date.now(),
    stage: 'script',
    rawScript: '',
    targetDuration: '60s',
    language: '中文',
    visualStyle: '3d-animation',
    shotGenerationModel: getConfiguredChatModelId(),
    scriptData: null,
    shots: [],
    isParsingScript: false,
    renderLogs: [],
    characterRefs: [],
    sceneRefs: [],
    propRefs: [],
    promptTemplateOverrides: undefined,
    scriptGenerationCheckpoint: null,
  };
};

// =============================================
// Legacy ProjectState compat (episodes store)
// =============================================

export const saveProjectToDB = async (project: ProjectState): Promise<void> => {
  return saveEpisode(project);
};

export const loadProjectFromDB = async (id: string): Promise<ProjectState> => {
  return loadEpisode(id);
};

export const getAllProjectsMetadata = async (): Promise<ProjectState[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EP_STORE, 'readonly');
    const req = tx.objectStore(EP_STORE).getAll();
    req.onsuccess = () => {
      const eps = ((req.result as ProjectState[]) || []).map(ep => normalizeEpisode(ep as Episode));
      eps.sort((a, b) => b.lastModified - a.lastModified);
      resolve(eps);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteProjectFromDB = async (id: string): Promise<void> => {
  return deleteEpisode(id);
};

export const createNewProjectState = (): ProjectState => {
  return createNewEpisode('', '', 1, '未命名项目');
};

// =============================================
// Asset Library Operations (unchanged)
// =============================================

export const saveAssetToLibrary = async (item: AssetLibraryItem): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readwrite');
    tx.objectStore(ASSET_STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getAllAssetLibraryItems = async (): Promise<AssetLibraryItem[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readonly');
    const req = tx.objectStore(ASSET_STORE_NAME).getAll();
    req.onsuccess = () => {
      const items = (req.result as AssetLibraryItem[]) || [];
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
};

export const deleteAssetFromLibrary = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE_NAME, 'readwrite');
    tx.objectStore(ASSET_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// =============================================
// Export / Import
// =============================================

export const exportIndexedDBData = async (): Promise<IndexedDBExportPayload> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeNames = [ASSET_STORE_NAME, SP_STORE, SERIES_STORE, EP_STORE];
    const tx = db.transaction(storeNames, 'readonly');
    const assetReq = tx.objectStore(ASSET_STORE_NAME).getAll();
    const spReq = tx.objectStore(SP_STORE).getAll();
    const seriesReq = tx.objectStore(SERIES_STORE).getAll();
    const epReq = tx.objectStore(EP_STORE).getAll();

    tx.oncomplete = () => {
      void (async () => {
        try {
          const episodes = (epReq.result as Episode[]) || [];
          const portableEpisodes = await Promise.all(
            episodes.map(ep => materializeProjectVideosForExport(normalizeEpisode(ep)))
          );

          resolve({
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedAt: Date.now(),
            scope: 'all',
            dbName: DB_NAME,
            dbVersion: DB_VERSION,
            stores: {
              projects: [],
              assetLibrary: (assetReq.result as AssetLibraryItem[]) || [],
              seriesProjects: (spReq.result as SeriesProject[]) || [],
              series: (seriesReq.result as Series[]) || [],
              episodes: portableEpisodes as Episode[],
            },
          });
        } catch (error) {
          reject(error);
        }
      })();
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const exportProjectData = async (project: ProjectState): Promise<IndexedDBExportPayload> => {
  const portableProject = await materializeProjectVideosForExport(project);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    scope: 'episode',
    dbName: DB_NAME,
    dbVersion: DB_VERSION,
    stores: {
      projects: [portableProject],
      assetLibrary: [],
    },
  };
};

export const exportSeriesProjectData = async (projectId: string): Promise<IndexedDBExportPayload> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeNames = [SP_STORE, SERIES_STORE, EP_STORE];
    const tx = db.transaction(storeNames, 'readonly');
    const spReq = tx.objectStore(SP_STORE).get(projectId);
    const seriesReq = tx.objectStore(SERIES_STORE).index('projectId').getAll(projectId);
    const epReq = tx.objectStore(EP_STORE).index('projectId').getAll(projectId);

    tx.oncomplete = () => {
      void (async () => {
        const seriesProject = spReq.result as SeriesProject | undefined;
        if (!seriesProject) {
          reject(new Error('Project not found'));
          return;
        }

        try {
          const rawEpisodes = ((epReq.result as Episode[]) || []).map(normalizeEpisode);
          const portableEpisodes = await Promise.all(
            rawEpisodes.map(ep => materializeProjectVideosForExport(ep))
          );

          resolve({
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedAt: Date.now(),
            scope: 'project',
            dbName: DB_NAME,
            dbVersion: DB_VERSION,
            stores: {
              projects: [],
              assetLibrary: [],
              seriesProjects: [seriesProject],
              series: (seriesReq.result as Series[]) || [],
              episodes: portableEpisodes as Episode[],
            },
          });
        } catch (error) {
          reject(error);
        }
      })();
    };
    tx.onerror = () => reject(tx.error);
  });
};

const isValidExportPayload = (data: unknown): data is IndexedDBExportPayload => {
  const p = data as IndexedDBExportPayload;
  return !!(p && p.stores);
};

export const importIndexedDBData = async (
  payload: unknown,
  options?: { mode?: 'merge' | 'replace' }
): Promise<{ projects: number; assets: number }> => {
  if (!isValidExportPayload(payload)) throw new Error('导入文件格式不正确');

  const mode = options?.mode || 'merge';
  const db = await openDB();
  const importedEpisodes = await Promise.all(
    ((payload.stores.episodes || []) as Episode[]).map(async (ep) => {
      try {
        return await normalizeAndPersistEpisodeVideos(ep);
      } catch (error) {
        console.warn('Failed to normalize imported episode video storage. Keep original payload.', error);
        return normalizeEpisode(ep);
      }
    })
  );

  const storeNames = [ASSET_STORE_NAME, SP_STORE, SERIES_STORE, EP_STORE];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');

    if (mode === 'replace') {
      storeNames.forEach(s => tx.objectStore(s).clear());
    }

    let count = 0;
    const assetStore = tx.objectStore(ASSET_STORE_NAME);
    (payload.stores.assetLibrary || []).forEach((item: AssetLibraryItem) => {
      assetStore.put(item);
      count++;
    });

    const spStore = tx.objectStore(SP_STORE);
    (payload.stores.seriesProjects || []).forEach((sp: SeriesProject) => { spStore.put(sp); count++; });

    const seriesStr = tx.objectStore(SERIES_STORE);
    (payload.stores.series || []).forEach((s: Series) => { seriesStr.put(s); count++; });

    const epStore = tx.objectStore(EP_STORE);
    importedEpisodes.forEach((ep: Episode) => { epStore.put(ep); count++; });

    if (payload.stores.projects && payload.stores.projects.length > 0 && !(payload.stores.episodes && payload.stores.episodes.length > 0)) {
      payload.stores.projects.forEach((p: any) => {
        if (p.shots) {
          p.shots.forEach((s: any) => {
            if (s.videoModel === 'veo-r2v' || s.videoModel === 'veo') {
              s.videoModel = 'veo_3_1-fast';
            }
          });
        }
        if (!p.renderLogs) p.renderLogs = [];
        if (p.scriptData && !p.scriptData.props) p.scriptData.props = [];

        const genId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const projectId = genId('sproj');
        const seriesId = genId('series');
        const episodeId = genId('ep');

        const chars = p.scriptData?.characters || [];
        const scenes = p.scriptData?.scenes || [];
        const props = p.scriptData?.props || [];
        const episodeScenes = scenes.map((s: any) => ({ ...s, libraryId: s.id, libraryVersion: 1 }));
        const episodeProps = props.map((pr: any) => ({ ...pr, libraryId: pr.id, libraryVersion: 1 }));

        const sp: SeriesProject = {
          id: projectId, title: p.title, createdAt: p.createdAt || Date.now(), lastModified: p.lastModified || Date.now(),
          visualStyle: p.visualStyle || '3d-animation', language: p.language || '中文',
          artDirection: p.scriptData?.artDirection,
          characterLibrary: chars.map((c: any) => ({ ...c, version: 1 })),
          sceneLibrary: scenes.map((s: any) => ({ ...s, version: 1 })),
          propLibrary: props.map((pr: any) => ({ ...pr, version: 1 })),
        };
        spStore.put(sp);

        const s: Series = { id: seriesId, projectId, title: '第一季', sortOrder: 0, createdAt: Date.now(), lastModified: Date.now() };
        seriesStr.put(s);

        const ep: Episode = {
          id: episodeId, projectId, seriesId, episodeNumber: 1,
          title: `第 1 集`,
          createdAt: p.createdAt || Date.now(), lastModified: p.lastModified || Date.now(),
          stage: p.stage || 'script', rawScript: p.rawScript || '', targetDuration: p.targetDuration || '60s',
          language: p.language || '中文', visualStyle: p.visualStyle || '3d-animation',
          shotGenerationModel: normalizeStoredChatModel(p.shotGenerationModel),
          scriptData: p.scriptData
            ? {
                ...p.scriptData,
                characters: chars.map((c: any) => ({ ...c, libraryId: c.id, libraryVersion: 1 })),
                scenes: episodeScenes,
                props: episodeProps,
              }
            : null,
          shots: p.shots || [], isParsingScript: false, renderLogs: p.renderLogs || [],
          characterRefs: chars.map((c: any) => ({ characterId: c.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          sceneRefs: scenes.map((s: any) => ({ sceneId: s.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          propRefs: props.map((pr: any) => ({ propId: pr.id, syncedVersion: 1, syncStatus: 'synced' as const })),
          promptTemplateOverrides: sanitizePromptTemplateOverrides(p.promptTemplateOverrides),
          scriptGenerationCheckpoint: null,
        };
        epStore.put(normalizeEpisode(ep));
        count += 3;
      });
    }

    tx.oncomplete = () => resolve({ projects: count, assets: (payload.stores.assetLibrary || []).length });
    tx.onerror = () => reject(tx.error);
  });
};

// =============================================
// Utilities
// =============================================

export const convertImageToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('只支持图片文件')); return; }
    if (file.size > 10 * 1024 * 1024) { reject(new Error('图片大小不能超过 10MB')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
};
