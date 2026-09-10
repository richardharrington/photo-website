import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useResource } from '../../shared/ui/useResource.ts';
import { Layout } from '../../shared/ui/Layout.tsx';
import { ErrorState, Loading } from '../../shared/ui/States.tsx';
import { adminApi } from '../api.ts';
import type { Recipient } from '../api.ts';
import { ConfirmDialog } from './Confirm.tsx';

/** A stable empty list, so a render with no data is not a new array. */
const NO_RECIPIENTS: readonly Recipient[] = [];

/**
 * One of a row's three switches.
 *
 * The accessible name says which one, because a row now carries three and
 * "On" alone would leave a screen reader announcing the same thing three
 * times.
 */
function Switch({
  label,
  on,
  disabled,
  title,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  title: string | undefined;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="emails__switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={on}
        disabled={disabled}
        title={title}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{on ? 'On' : 'Off'}</span>
    </label>
  );
}

/**
 * `lastSent.at` is a genuine instant, unlike a capture time, so it is shown in
 * the reader's own zone — the administrator wants to know when the mail went
 * out by their clock, not the camera's.
 */
function sentAt(at: string): string {
  return new Date(at).toLocaleString();
}

function photos(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/**
 * Every address the site has anything to do with, and what each may do.
 *
 * The list here is **Cloudflare's**, not this site's. Adding an address creates
 * a destination address in the Cloudflare account, which is what sends the
 * confirmation link; removing one deletes it there. Nothing is stored about an
 * address anywhere else except the three switches and how far the digest has
 * told it about (decisions.md, "Notifications").
 *
 * Every action refetches the whole list rather than patching a row. The list is
 * a handful of rows, the truth is remote, and a verification that landed while
 * the page was open should appear the moment anything else is done.
 */
export function EmailsPage({ nav }: { nav: ReactNode }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  /** The inline result of "Send test", keyed by address. One row at a time. */
  const [tested, setTested] = useState<{ email: string; message: string } | null>(null);
  const [removing, setRemoving] = useState<Recipient | null>(null);

  const resource = useResource<{ recipients: Recipient[] }>(
    (signal) => adminApi.emails(signal),
    [reloadKey],
  );

  const recipients =
    resource.status === 'ready' ? resource.data.recipients : NO_RECIPIENTS;

  function reload() {
    setReloadKey((key) => key + 1);
  }

  /** Every action shares this shape: clear, act, reload, report. */
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be done.');
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const wanted = email.trim();
    if (wanted === '') return;
    setAdded(null);
    setTested(null);
    await act(async () => {
      const { recipient } = await adminApi.addRecipient(wanted);
      setEmail('');
      setAdded(recipient.email);
    });
  }

  async function setEnabled(recipient: Recipient, enabled: boolean) {
    setTested(null);
    await act(() => adminApi.setRecipientEnabled(recipient.email, enabled));
  }

  async function setCanSubmit(recipient: Recipient, canSubmit: boolean) {
    setTested(null);
    await act(() => adminApi.setRecipientCanSubmit(recipient.email, canSubmit));
  }

  async function setReviewsInbox(recipient: Recipient, reviewsInbox: boolean) {
    setTested(null);
    await act(() => adminApi.setRecipientReviewsInbox(recipient.email, reviewsInbox));
  }

  async function sendTest(recipient: Recipient) {
    setTested(null);
    setBusy(true);
    setError(null);
    try {
      const { count } = await adminApi.sendTest(recipient.email);
      setTested({
        email: recipient.email,
        message:
          count === 0
            ? 'Sent: no new photos'
            : `Sent: ${count} new photo${count === 1 ? '' : 's'}`,
      });
    } catch (cause) {
      setTested({
        email: recipient.email,
        message: cause instanceof Error ? cause.message : 'The test could not be sent.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(recipient: Recipient) {
    setRemoving(null);
    setAdded(null);
    setTested(null);
    await act(() => adminApi.removeRecipient(recipient.id));
  }

  if (resource.status === 'loading') {
    return (
      <Layout nav={nav}>
        <Loading />
      </Layout>
    );
  }
  if (resource.status === 'error' || resource.status === 'not-found') {
    return (
      <Layout nav={nav}>
        <ErrorState
          message={
            resource.status === 'error'
              ? resource.message
              : 'The recipient list could not be read.'
          }
        />
      </Layout>
    );
  }

  return (
    <>
      <Layout nav={nav}>
        <p className="emails__intro">
          Each of these addresses gets one plain-text email a day when new photos have
          been added — a count and a link, nothing else. Nothing is sent to an address
          until its owner confirms it.
        </p>
        <p className="emails__intro">
          <strong>Can submit</strong> lets an address email photographs to the site;
          they wait in the Inbox until you have looked at them, and nobody else sees
          them before that. <strong>Reviews inbox</strong> adds a line to that
          address&rsquo;s daily email saying how much is waiting — and sends it even on
          a day when nothing new arrived.
        </p>

        <form className="emails__add" onSubmit={(event) => void add(event)}>
          <label htmlFor="emails-address">Add an address</label>
          <input
            id="emails-address"
            type="email"
            autoComplete="off"
            value={email}
            placeholder="name@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
          <button type="submit" disabled={busy || email.trim() === ''}>
            Add
          </button>
        </form>

        {added ? (
          <p className="emails__note" role="status">
            Cloudflare has emailed {added} a link to confirm. Nothing is sent until they
            click it.
          </p>
        ) : null}

        {error ? (
          <p className="admin-error" role="alert">
            {error}
          </p>
        ) : null}

        {recipients.length === 0 ? (
          <p className="state state--empty">Nobody is on the list yet.</p>
        ) : (
          <div className="emails__scroll">
            <table className="emails">
              <thead>
                <tr>
                  <th scope="col">Address</th>
                  <th scope="col">Status</th>
                  <th scope="col">Notifications</th>
                  <th scope="col">Can submit</th>
                  <th scope="col">Reviews inbox</th>
                  <th scope="col">Last sent</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((recipient) => (
                  <tr key={recipient.id}>
                    <td>{recipient.email}</td>
                    <td>
                      <span
                        className={
                          recipient.verified
                            ? 'emails__badge'
                            : 'emails__badge emails__badge--pending'
                        }
                      >
                        {recipient.verified ? 'Verified' : 'Awaiting verification'}
                      </span>
                    </td>
                    {/*
                     * Three switches, not actions: each is a state, and each is
                     * inert until Cloudflare has the confirmation. Verification
                     * proves someone controls the mailbox; for Can submit, DKIM
                     * proves a message came from it. Neither alone is enough,
                     * which is why the switch waits for the first.
                     */}
                    <td>
                      <Switch
                        label="Notifications"
                        on={recipient.enabled}
                        disabled={busy || !recipient.verified}
                        title={
                          recipient.verified
                            ? undefined
                            : 'Nothing is sent until this address is confirmed.'
                        }
                        onChange={(next) => void setEnabled(recipient, next)}
                      />
                    </td>
                    <td>
                      <Switch
                        label="Can submit"
                        on={recipient.canSubmit}
                        disabled={busy || !recipient.verified}
                        title={
                          recipient.verified
                            ? undefined
                            : 'Mail is only accepted from a confirmed address.'
                        }
                        onChange={(next) => void setCanSubmit(recipient, next)}
                      />
                    </td>
                    <td>
                      <Switch
                        label="Reviews inbox"
                        on={recipient.reviewsInbox}
                        disabled={busy || !recipient.verified}
                        title={
                          recipient.verified
                            ? undefined
                            : 'Nothing is sent until this address is confirmed.'
                        }
                        onChange={(next) => void setReviewsInbox(recipient, next)}
                      />
                    </td>
                    <td>
                      {recipient.lastSent ? (
                        <>
                          {sentAt(recipient.lastSent.at)}
                          <span className="emails__count">
                            {photos(recipient.lastSent.count)}
                          </span>
                        </>
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td>
                      <div className="emails__actions">
                        <button
                          type="button"
                          disabled={busy || !recipient.verified}
                          title={
                            recipient.verified
                              ? undefined
                              : 'Cloudflare will not deliver to an unconfirmed address.'
                          }
                          onClick={() => void sendTest(recipient)}
                        >
                          Send test
                        </button>
                        <button
                          type="button"
                          className="admin-danger"
                          disabled={busy}
                          onClick={() => setRemoving(recipient)}
                        >
                          Remove
                        </button>
                      </div>
                      {tested?.email === recipient.email ? (
                        <p className="emails__result" role="status">
                          {tested.message}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Layout>

      {removing ? (
        <ConfirmDialog
          title="Remove this address?"
          confirmLabel="Remove"
          destructive
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          <strong>{removing.email}</strong> will be deleted from the Cloudflare account
          and will stop receiving updates. Adding it again means confirming it again.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
