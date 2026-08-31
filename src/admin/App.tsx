import { useCallback, useState } from 'react';
import { navigate, useLocationPath } from '../shared/ui/navigation.ts';
import { Link } from '../shared/ui/Link.tsx';
import { useResource } from '../shared/ui/useResource.ts';
import { formatCaptureDate, formatMonth, monthName } from '../shared/datetime.ts';
import { adminApi, routes } from './api.ts';
import type { PreviewResult } from './api.ts';
import { parseAdminRoute } from './routes.ts';
import type { AdminRoute } from './routes.ts';
import { AdminGrid } from './components/AdminGrid.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { Confirm, UndoBanner } from './components/Confirm.tsx';
import { TrashView } from './components/TrashView.tsx';
import { UploadPanel } from './components/Upload.tsx';
import { EMPTY_SELECTION, pruneToVisible, selectedIds } from './selection.ts';
import type { SelectionState } from './selection.ts';
import type {
  GroupResponse,
  HierarchyResponse,
  PublicPhoto,
} from '../shared/display-api.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The selection a group page's "delete this whole group" action refers to. */
function groupQuery(route: AdminRoute): SelectionQuery | null {
  switch (route.kind) {
    case 'year':
      return { kind: 'year', year: route.year };
    case 'month':
      return { kind: 'month', year: route.year, month: route.month };
    case 'day':
      return { kind: 'day', year: route.year, month: route.month, day: route.day };
    case 'undated':
      return { kind: 'undated' };
    default:
      return null;
  }
}

export function App() {
  const path = useLocationPath();
  const route = parseAdminRoute(path, __APP_BASE__);

  const [reloadKey, setReloadKey] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [openPhoto, setOpenPhoto] = useState<PublicPhoto | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [undo, setUndo] = useState<{ ids: string[]; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setSelection(EMPTY_SELECTION);
    setOpenPhoto(null);
    setReloadKey((key) => key + 1);
  }, []);

  const hierarchy = useResource<HierarchyResponse>(
    (signal) => adminApi.hierarchy(signal),
    [reloadKey],
  );

  async function startTrash(selectionQuery: SelectionQuery) {
    setError(null);
    try {
      setPreview(await adminApi.previewTrash(selectionQuery));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmTrash() {
    if (!preview) return;
    try {
      const result = await adminApi.confirmTrash(preview);
      setPreview(null);
      setUndo({
        ids: result.trashed,
        message: `${result.count} photo${result.count === 1 ? '' : 's'} deleted.`,
      });
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    }
  }

  async function performUndo() {
    if (!undo) return;
    try {
      await adminApi.restore(undo.ids);
      setUndo(null);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restore failed.');
    }
  }

  // A persistent Trash link with its item count (design.md, "Admin site").
  const trash = useResource<{ count: number }>(
    (signal) => adminApi.trashCount(signal),
    [reloadKey],
  );
  const trashCount = trash.status === 'ready' ? trash.data.count : null;

  return (
    <div className="admin">
      <header className="admin__header">
        <Link to={routes.home()} className="admin__title">
          {__SITE_TITLE__} — Administration
        </Link>
        <nav className="admin__nav">
          <Link to={routes.trash()}>
            Trash{trashCount === null ? '' : ` (${trashCount})`}
          </Link>
          <a href={adminApi.exportUrl()} download>
            Export catalog
          </a>
        </nav>
      </header>

      <main className="admin__main">
        {error ? (
          <p className="detail__error" role="alert">
            {error}
          </p>
        ) : null}

        {route.kind === 'trash' ? (
          <TrashView onChanged={reload} />
        ) : (
          <BrowseView
            route={route}
            hierarchy={hierarchy}
            reloadKey={reloadKey}
            selection={selection}
            onSelectionChange={setSelection}
            onOpenPhoto={setOpenPhoto}
            onTrashSelection={(ids) => void startTrash({ kind: 'ids', photoIds: ids })}
            onTrashGroup={(query) => void startTrash(query)}
            onReload={reload}
          />
        )}
      </main>

      {openPhoto ? (
        <DetailPanel
          photo={openPhoto}
          onClose={() => setOpenPhoto(null)}
          onSaved={(photo) => {
            setOpenPhoto(photo);
            setReloadKey((key) => key + 1);
          }}
          onTrash={(photoId) => void startTrash({ kind: 'ids', photoIds: [photoId] })}
        />
      ) : null}

      {preview ? (
        <Confirm
          preview={preview}
          title="Delete photos?"
          description="will move to the trash, where they are kept for 30 days."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void confirmTrash()}
          onCancel={() => setPreview(null)}
        />
      ) : null}

      {undo ? (
        <UndoBanner
          message={undo.message}
          onUndo={() => void performUndo()}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
    </div>
  );
}

interface BrowseViewProps {
  route: AdminRoute;
  hierarchy: ReturnType<typeof useResource<HierarchyResponse>>;
  reloadKey: number;
  selection: SelectionState;
  onSelectionChange: (selection: SelectionState) => void;
  onOpenPhoto: (photo: PublicPhoto) => void;
  onTrashSelection: (ids: string[]) => void;
  onTrashGroup: (query: SelectionQuery) => void;
  onReload: () => void;
}

function BrowseView(props: BrowseViewProps) {
  const { route, hierarchy, reloadKey, onReload } = props;

  const isGrid = route.kind === 'day' || route.kind === 'undated';

  const group = useResource<GroupResponse | null>(
    (signal) => {
      if (route.kind === 'day') {
        return adminApi.day(route.year, route.month, route.day, signal);
      }
      if (route.kind === 'undated') return adminApi.undated(signal);
      return Promise.resolve(null);
    },
    [route.kind, JSON.stringify(route), reloadKey],
  );

  const libraryIsEmpty =
    hierarchy.status === 'ready' &&
    hierarchy.data.total === 0 &&
    hierarchy.data.undated.count === 0;

  return (
    <>
      {/* Always large and easy to target; more prominent when there is
          nothing in the library yet. */}
      <UploadPanel onBatchComplete={onReload} emphasized={libraryIsEmpty} />

      {route.kind === 'not-found' ? <p className="state">Not found.</p> : null}

      {!isGrid && route.kind !== 'not-found' ? <IndexView {...props} /> : null}

      {isGrid ? <GridView {...props} group={group} /> : null}
    </>
  );
}

function IndexView({ route, hierarchy }: BrowseViewProps) {
  if (hierarchy.status !== 'ready') {
    return (
      <p className="state">
        {hierarchy.status === 'error' ? hierarchy.message : 'Loading…'}
      </p>
    );
  }

  const data = hierarchy.data;

  if (route.kind === 'home') {
    const entries = [
      ...data.years.map((year) => ({
        href: routes.year(year.year),
        label: String(year.year),
        count: year.count,
      })),
      ...(data.undated.count > 0
        ? [{ href: routes.undated(), label: 'Undated', count: data.undated.count }]
        : []),
    ];
    return entries.length === 0 ? (
      <p className="state state--empty">No photos here yet.</p>
    ) : (
      <GroupLinks entries={entries} />
    );
  }

  if (route.kind === 'year') {
    const year = data.years.find((entry) => entry.year === route.year);
    if (!year) return <p className="state">Not found.</p>;
    return (
      <GroupLinks
        entries={year.months.map((month) => ({
          href: routes.month(route.year, month.month),
          label: monthName(month.month),
          count: month.count,
        }))}
      />
    );
  }

  if (route.kind === 'month') {
    const month = data.years
      .find((entry) => entry.year === route.year)
      ?.months.find((entry) => entry.month === route.month);
    if (!month) return <p className="state">Not found.</p>;
    return (
      <>
        <h1 className="layout__title">{formatMonth(route.year, route.month)}</h1>
        <GroupLinks
          entries={month.days.map((day) => ({
            href: routes.day(route.year, route.month, day.day),
            label: formatCaptureDate(
              `${route.year}-${pad2(route.month)}-${pad2(day.day)}`,
            ),
            count: day.count,
          }))}
        />
      </>
    );
  }

  return null;
}

function GroupLinks({
  entries,
}: {
  entries: readonly { href: string; label: string; count: number }[];
}) {
  return (
    <ul className="group-list">
      {entries.map((entry) => (
        <li key={entry.href}>
          <Link to={entry.href} className="group-list__link">
            <span className="group-list__label">{entry.label}</span>
            <span className="group-list__count">
              {entry.count} photo{entry.count === 1 ? '' : 's'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function GridView({
  route,
  group,
  selection,
  onSelectionChange,
  onOpenPhoto,
  onTrashSelection,
  onTrashGroup,
}: BrowseViewProps & { group: ReturnType<typeof useResource<GroupResponse | null>> }) {
  if (group.status === 'loading') return <p className="state">Loading…</p>;
  if (group.status === 'not-found') return <p className="state">Not found.</p>;
  if (group.status === 'error') {
    return (
      <p className="state" role="alert">
        {group.message}
      </p>
    );
  }
  if (!group.data) return null;

  const photos = group.data.photos;
  // A selection must never outlive the photos it names.
  const live = pruneToVisible(
    selection,
    photos.map((photo) => photo.id),
  );
  const chosen = selectedIds(live);
  const query = groupQuery(route);

  const title =
    route.kind === 'day'
      ? formatCaptureDate(`${route.year}-${pad2(route.month)}-${pad2(route.day)}`)
      : 'Undated';

  return (
    <>
      <div className="admin__toolbar">
        <h1 className="layout__title">{title}</h1>
        <div className="admin__toolbar-actions">
          <span aria-live="polite">{chosen.length} selected</span>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onTrashSelection(chosen)}
          >
            Delete selected
          </button>
          {query ? (
            <button
              type="button"
              disabled={photos.length === 0}
              onClick={() => onTrashGroup(query)}
            >
              Delete this whole group
            </button>
          ) : null}
        </div>
      </div>

      {photos.length === 0 ? (
        <p className="state state--empty">No photos here yet.</p>
      ) : (
        <AdminGrid
          photos={photos}
          selection={live}
          onSelectionChange={onSelectionChange}
          onOpen={(photoId) => {
            const photo = photos.find((candidate) => candidate.id === photoId);
            if (photo) onOpenPhoto(photo);
            else navigate(routes.photo(photoId));
          }}
        />
      )}
    </>
  );
}
