/**
 * The shape of one archived transaction, and of the manifest that names a set
 * of them.
 *
 * Several commands write into the evidence trees, and more arrive as the
 * application grows. Every writer compiles against one definition of the
 * shape. A change of the shape therefore breaks a build. Without that one
 * definition it would produce a row that looks right and is wrong.
 */

/** How a row came to exist. */
export type Producer = 'script' | 'browser' | 'device';

/** The text and the figures that a person read on a screen. */
export interface Shown {
  /** The title of the result, such as `Paid`. */
  readonly title: string;
  /** The sentence that told the person what to do next. */
  readonly advice: string;
  /**
   * The figures as the screen rendered them.
   *
   * The chain carries these values too. They stay here because they make a
   * claim about the application and not about the network. A later check
   * compares each one against the chain.
   */
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * One webhook message, as a receiver got it.
 *
 * Every value inside the message body is a chain fact, so the archive rule
 * would normally exclude all of it. The body stays here for one reason: the
 * claim is not what the message says, it is that the message arrived. The body
 * is the delivered artifact rather than a copy of a chain value.
 *
 * What this proves and what it does not. A later check parses the body, reads
 * the same transaction from the network and compares every field, then checks
 * that the message arrived after the ledger closed. A body that disagrees with
 * the chain fails, and so does one that claims to arrive before the event it
 * describes existed. That is consistency and ordering against a source that we
 * did not write.
 *
 * It is not authenticity. Nobody can tell a captured message from a composed
 * one by looking at the bytes, and this archive does not pretend otherwise.
 */
export interface Delivery {
  /** When the receiver read the message. */
  readonly receivedAt: string;
  /** The request line, which says what the listener sent and where. */
  readonly method: string;
  readonly path: string;
  /** The headers that the listener set, which the chain never carries. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The digest of the exact bytes, so a later edit of the body shows. */
  readonly bodySha256: string;
  /** The body, byte for byte as it arrived. */
  readonly body: string;
}

/**
 * One payee-presented request, as the payer received it.
 *
 * The chain carries the payment: a source, a destination, an amount and a fee.
 * It carries nothing about the request that asked for the payment. The request
 * is the artifact this row is about, so it is stored whole, for the same reason
 * the webhook body is: the claim is that this request existed and that this
 * payment answered it.
 *
 * The signing key is stored beside the request rather than fetched when a check
 * runs. A later reader can then verify the signature with no network at all,
 * which is the property that keeps the row readable after the domain changes
 * its published key or stops answering. `tomlUrl` records where the key was
 * read, so the stored key stays a claim that a reader can go and test against
 * the live domain while the domain still exists.
 *
 * The two questions are deliberately separate. Did this key sign this request,
 * which stays answerable for ever. Does the domain still publish this key,
 * which decays and is allowed to.
 */
export interface Sep7Request {
  /** The request, byte for byte, with its signature. */
  readonly uri: string;
  /** The domain that the request names as its origin. */
  readonly originDomain: string;
  /** The key that this archive verified the signature against. */
  readonly signingKey: string;
  /** Where that key was read, so a reader can test the claim while it lasts. */
  readonly tomlUrl: string;
}

/**
 * One row of a manifest.
 *
 * A row needs three fields only: a name, a hash, and one sentence that says
 * what the row shows. Every other field is optional. A row is therefore
 * complete when a producer writes it during a run. It is equally complete when
 * a person recovers it later from a hash alone. Nothing that the chain already
 * carries belongs here. The voucher identifier, the amount, the payer, the
 * recipient, the ledger and the fee all reach the archive from the network.
 */
export interface Row {
  /** Unique inside its tree. It names the archive file. */
  readonly name: string;
  /** The transaction that the row cites. */
  readonly hash: string;
  /** One sentence: what this row shows. */
  readonly note: string;
  /** The contract of the row, when the manifest names another one. */
  readonly contractId?: string;
  /** How the row came to exist. */
  readonly producer?: Producer;
  /** The screen that produced the row, for a browser or a device. */
  readonly screen?: string;
  /** What a person read on that screen. */
  readonly shown?: Shown;
  /** The webhook message that the listener posted for this transaction. */
  readonly delivery?: Delivery;
  /** The payee-presented request that this payment answered. */
  readonly request?: Sep7Request;
  /** Which batch of a load check the row belongs to. */
  readonly batch?: string;
  /** The number of the attempt that produced the row. The first attempt is one. */
  readonly attempt?: number;
  /** How long the client waited, in milliseconds. */
  readonly elapsedMs?: number;
}

/** A set of rows that one command produced. */
export interface Manifest {
  /** The network passphrase. */
  readonly network: string;
  /** The contract that the rows call, unless a row names another. */
  readonly contractId: string;
  /** When the command produced the set. */
  readonly producedAt: string;
  /**
   * The command that writes this set, as a path in the repository.
   *
   * A tree that names its own producer lets a check ask that command what it
   * makes, rather than a check carrying a list of every producer. A list has to
   * be edited whenever a producer is added, and a list that somebody forgets to
   * edit leaves a tree silently unchecked, which is the failure this field
   * removes.
   *
   * It says which command writes the file, and not that one run made every row
   * in it. Some sets are built up over many runs: a command that archives one
   * row at a time reads the set, adds a row and writes the whole file back, so
   * rows from earlier runs stay. The field is true of such a set because that
   * command wrote the file it sits in.
   *
   * It is therefore false until that command has written the file. Adding it by
   * hand to a set that no command writes makes a check pass on a claim that
   * nothing supports, which is the failure the check exists to find.
   */
  readonly producedBy?: string;
  /** The figures that the set claims, for a set that measures something. */
  readonly summary?: Readonly<Record<string, string | number | boolean | null>>;
  readonly rows: readonly Row[];
}

/** What Horizon says about a transaction. */
export interface HorizonSummary {
  readonly successful: boolean | null;
  readonly ledger: number | null;
  readonly fee_charged: string | null;
  readonly created_at: string | null;
  readonly source_account: string | null;
}

/** What the RPC server says about a transaction. */
export interface RpcSummary {
  readonly status: string | null;
  readonly ledger: number | null;
  readonly createdAt: string | null;
  readonly envelopeXdr: string | null;
  readonly resultXdr: string | null;
  readonly resultMetaXdr: string | null;
  readonly diagnosticEventsXdr: readonly string[] | null;
}

/** One row, with everything that the network said about it. */
export interface ArchivedRow extends Row {
  readonly contractId: string;
  readonly archivedAt: string;
  readonly rpc: RpcSummary;
  readonly horizon: HorizonSummary | null;
}
