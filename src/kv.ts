/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:'),
    /** A digest of what a Source keeps outside the settings and still decides work by (its receiving-rule file); the Policy version carries it. */
    digests: family<string, [source: string]>('source-digest:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Yunxiao Source: the work-item search cursor, the loaded receiving-rule file with the hash the Policy version carries, the
   * last state of each work item it has seen (repair cycle, status, assignee, last comment read), and the result each ended
   * ticket has already written back.
   */
  yunxiao: { cursor: record<string>('yunxiao-cursor'),
    config: record<{ hash: string; file: unknown; at: string }>('yunxiao-config'),
    workitem: family<{ cycle: number; status: string; assignee: string; commentAt: string }, [id: string]>('yunxiao-workitem:'),
    writeback: family<{ at: string; ended?: string; status?: string }, [ticketId: string]>('yunxiao-writeback:'),
    /**
     * Per merge request: the head and CI fingerprint last seen, and the last comment read, so each change is reported once;
     * `gone` marks one the account can no longer read at all (deleted, or a repository it lost access to), whose Thread closed
     * and which no later round reads again.
     */
    mr: family<{ head: string; fingerprint: string; commentAt: string; revision: number; gone?: true }, [thread: string]>('yunxiao-mr:'),
    /**
     * What the approver answered about a work item of a triage project: `asked` until they reply, `go` when the work may start,
     * `declined` when they said not to. A new repair cycle asks again.
     */
    triage: family<{ state: 'asked' | 'go' | 'declined'; messageId?: string; answer?: string; at: string; cycle: number },
      [id: string]>('yunxiao-triage:'),
    /**
     * The status a Ticket's work item was moved to when its work started, with the repair cycle it was moved for: the move
     * happens once per cycle, so a work item reopened into a new cycle is moved again.
     */
    started: family<{ at: string; status: string; cycle?: number }, [ticketId: string]>('yunxiao-started:'),
    qa: family<{ pipelineId: string; runId: string; repository: string; branch: string; commit: string;
      qaBranch?: string; qaCommit?: string; mergeRequest?: number; integrationBranch?: string; integrationCommit?: string },
      [ticketId: string, repository: string]>('yunxiao-qa:'),
    qaDelivery: family<{ branch: string; commit: string; sourceBranch: string; sourceCommit: string; qaBranch: string;
      beforeRunId: string; qaCommit?: string; mergeRequest?: number; createAttempted?: true; createdRunId?: string }, [ticketId: string, repository: string]>('yunxiao-qa-delivery:'),
    qaMr: family<{ ticketId: string; repository: string; mergeRequest: number; sourceBranch: string; qaBranch: string; commit: string; superseded?: true },
      [organization: string, repository: string, localId: number]>('yunxiao-qa-mr:'),
    qaScope: family<{ branch: string; repositories: string[] }, [ticketId: string]>('yunxiao-qa-scope:'),
    qaPlan: family<{ environment: string; projects: { repository: string; pipelineId: string; command: string; directory: string;
      qaBranch?: string; mergeMode?: 'direct' | 'merge-request'; integrationBranch?: string; integrationDirectory?: string;
      integrationCommit?: string; integrationOutput?: string;
      commit?: string; output?: string }[]; tested?: boolean }, [ticketId: string]>('yunxiao-qa-plan:'),
    qaTest: family<{ environment: string; command: string; output: string; at: string;
      projects: { repository: string; pipelineId: string; runId: string; commit: string; qaBranch?: string; qaCommit?: string }[] }, [ticketId: string]>('yunxiao-qa-test:'),
    qaLatest: family<{ runId: string }, [organization: string, pipelineId: string]>('yunxiao-qa-latest:') },
  /**
   * Merge approvals: the state of each change request a ticket asked to merge, the confirmation message it waits on, and the
   * message ids a person's reply may answer.
   */
  merge: { mr: family<{ state: string; messageId?: string; commit: string; target: string; confirmedAt?: string },
    [thread: string]>('merge-mr:'),
    /** One confirmation message the approver answers: a merge, a pipeline outside the ones a worker may run itself, or a PRE statement. */
    /** `kind` is one of merge, pipeline, sql, triage and ticket; merge.ts narrows it for its own records. */
    message: family<{ thread: string; ticketId: string; at: string; kind?: string
      pipeline?: { id: string; name: string }
      sql?: readonly { title: string; file: string; database: string; phase: 'before' | 'after'; fingerprint: string }[]
      /** A triage question names the work item it asks about; a ticket's own message names the ticket an answer belongs to. */
      workitemId?: string
      /** A triage question names the trigger whose assessment left the decision to a person. */
      triggerId?: string },
      [messageId: string]>('merge-message:'),
    /** The approver bound by their first direct message to the bot, when the receiving rules name none. */
    approver: record<{ openId: string; chatId: string; at: string }>('merge-approver') },
  /**
   * Statements approved for PRE, by content fingerprint and target database, so one statement runs once and a changed
   * statement needs a new approval.
   */
  sql: { approved: family<{ ticketId: string; at: string; database: string }, [fingerprint: string]>('sql-approved:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
