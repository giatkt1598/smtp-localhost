import React, {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type MessageSummary = {
  id: string;
  source: "smtp" | "sendgrid-api";
  createdAt: string;
  isRead: boolean;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  raw: string;
  attachments: Array<{ filename: string; type?: string; size: number }>;
};

type MessageDetail = MessageSummary & {
  cc: string[];
  bcc: string[];
  headers: Record<string, string>;
  replyTo?: string;
  envelopeFrom?: string;
  envelopeTo: string[];
};

type ListResponse = {
  items: MessageSummary[];
  total: number;
};

type Tab = "message" | "plain" | "raw" | "json";
type MailEvent =
  | { kind: "new-message"; message: MessageSummary }
  | { kind: "inbox-updated" };

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(message: MessageSummary) {
  const source = message.text || stripHtml(message.html) || message.raw;
  return source.replace(/\s+/g, " ").trim().slice(0, 120);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.json() as Promise<T>;
}

function App() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<MessageDetail | null>(null);
  const [tab, setTab] = useState<Tab>("message");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<
    Array<{ id: string; title: string; body: string }>
  >([]);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(
      typeof Notification !== "undefined" ? Notification.permission : "denied",
    );
  const loadMessagesRef = useRef<() => Promise<void>>(async () => undefined);

  const unreadCount = useMemo(
    () => messages.filter((item) => !item.isRead).length,
    [messages],
  );
  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedId) ?? null,
    [messages, selectedId],
  );

  async function loadMessages() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ListResponse>(
        `/api/messages?q=${encodeURIComponent(deferredQuery)}`,
      );
      setMessages(data.items);
      if (!data.items.length) {
        setSelectedId(null);
        setSelected(null);
      } else if (!data.items.some((item) => item.id === selectedId)) {
        setSelectedId(data.items[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được inbox");
    } finally {
      setLoading(false);
    }
  }

  loadMessagesRef.current = loadMessages;

  function pushToast(title: string, body: string) {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, title, body }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }

  function updateMessage(message: MessageDetail) {
    setMessages((current) =>
      current.map((item) =>
        item.id === message.id
          ? {
              ...item,
              isRead: message.isRead,
              subject: message.subject,
              from: message.from,
              to: message.to,
              text: message.text,
              html: message.html,
              raw: message.raw,
              attachments: message.attachments,
            }
          : item,
      ),
    );
    setSelected((current) => (current?.id === message.id ? message : current));
  }

  async function setReadState(id: string, isRead: boolean) {
    const action = isRead ? "read" : "unread";
    const result = await fetchJson<{ ok: boolean; message: MessageDetail }>(
      `/api/messages/${id}/${action}`,
      {
        method: "PATCH",
      },
    );
    updateMessage(result.message);
    if (!isRead && selectedId === id) {
      setSelected(result.message);
    }
  }

  async function openMessage(id: string) {
    setSelectedId(id);
  }

  useEffect(() => {
    void loadMessages();
  }, [deferredQuery]);

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.addEventListener("mail", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as MailEvent;
      if (payload.kind === "new-message") {
        pushToast(
          payload.message.subject || "New email received",
          payload.message.from || "Unknown sender",
        );
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification(payload.message.subject || "New email received", {
            body: payload.message.from || "Unknown sender",
          });
        }
      }

      void loadMessagesRef.current();
    });

    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    fetchJson<MessageDetail>(`/api/messages/${selectedId}`)
      .then((data) => {
        if (cancelled) return;
        setSelected(data);
        if (!data.isRead) {
          void setReadState(data.id, true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Không tải được chi tiết",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function clearInbox() {
    await fetchJson<{ ok: boolean }>("/api/messages", { method: "DELETE" });
    await loadMessages();
  }

  async function deleteSelected() {
    if (!selectedId) return;
    await fetchJson<{ ok: boolean }>(`/api/messages/${selectedId}`, {
      method: "DELETE",
    });
    await loadMessages();
  }

  async function markSelectedUnread() {
    if (!selectedId) return;
    await setReadState(selectedId, false);
  }

  async function markSelectedRead() {
    if (!selectedId) return;
    await setReadState(selectedId, true);
  }

  async function enableNotifications() {
    if (typeof Notification === "undefined") {
      pushToast(
        "Notifications unavailable",
        "Browser này không hỗ trợ Notification API.",
      );
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      pushToast("Notifications enabled", "Web notifications đã được bật.");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-kicker">SMTP Localhost</div>
            <div className="brand-title">Mailbox</div>
          </div>
        </div>

        <label className="search-shell" htmlFor="search">
          <span className="search-icon">⌕</span>
          <input
            id="search"
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mail"
          />
        </label>

        <div className="topbar-actions">
          <span className="pill">{unreadCount} unread</span>
          <button className="button" onClick={() => void enableNotifications()}>
            {notificationPermission === "granted"
              ? "Notifications on"
              : "Enable notifications"}
          </button>
          <button className="button" onClick={() => void loadMessages()}>
            Refresh
          </button>
        </div>
      </header>

      <main className="content">
        <section className="mailbox">
          <div className="mailbox-header">
            <div>
              <div className="section-label">Inbox</div>
              <div className="section-title">{messages.length} messages</div>
            </div>
            <button
              className="button danger"
              onClick={() => void clearInbox()}
              disabled={!messages.length}
            >
              Clear
            </button>
          </div>

          <div className="mail-list">
            {messages.map((message) => (
              <button
                key={message.id}
                className={`mail-item ${message.id === selectedId ? "selected" : ""} ${message.isRead ? "read" : "unread"}`}
                onClick={() => void openMessage(message.id)}
              >
                <span className="mail-dot" aria-hidden="true" />
                <div className="mail-body">
                  <div className="mail-head">
                    <span className="mail-sender">
                      {message.from || "Unknown sender"}
                    </span>
                    <span className="mail-time">
                      {formatDate(message.createdAt)}
                    </span>
                  </div>
                  <div className="mail-subject">
                    {message.subject || "(no subject)"}
                  </div>
                  <div className="mail-snippet">{snippet(message)}</div>
                </div>
                <div className="mail-tags">
                  {!message.isRead && <span className="unread-badge">New</span>}
                </div>
              </button>
            ))}

            {!messages.length && !loading && (
              <div className="empty-state">No email in inbox.</div>
            )}
          </div>
        </section>

        <section className="detail-pane">
          <div className="detail-toolbar">
            <div>
              <div className="section-label">Selected</div>
              <div className="section-title">
                {selectedMessage?.subject || "No message selected"}
              </div>
            </div>
            <div className="toolbar-buttons">
              <button
                className="button"
                onClick={() => void markSelectedUnread()}
                disabled={!selectedId}
              >
                Mark unread
              </button>
              <button
                className="button"
                onClick={() => void markSelectedRead()}
                disabled={!selectedId}
              >
                Mark read
              </button>
              <button
                className="button danger"
                onClick={() => void deleteSelected()}
                disabled={!selectedId}
              >
                Delete
              </button>
            </div>
          </div>

          {!selected ? (
            <div className="detail-empty">
              {detailLoading ? "Loading…" : "Select a email to view details"}
            </div>
          ) : (
            <>
              <div className="detail-card">
                <div className="detail-meta-grid">
                  <div>
                    <span className="field-label">From</span>
                    <div>{selected.from || selected.envelopeFrom || "-"}</div>
                  </div>
                  <div>
                    <span className="field-label">To</span>
                    <div>
                      {selected.to.join(", ") ||
                        selected.envelopeTo.join(", ") ||
                        "-"}
                    </div>
                  </div>
                  <div>
                    <span className="field-label">Cc</span>
                    <div>{selected.cc.join(", ") || "-"}</div>
                  </div>
                  <div>
                    <span className="field-label">Bcc</span>
                    <div>{selected.bcc.join(", ") || "-"}</div>
                  </div>
                  <div>
                    <span className="field-label">Status</span>
                    <div>{selected.isRead ? "Read" : "Unread"}</div>
                  </div>
                  <div>
                    <span className="field-label">Attachments</span>
                    <div>
                      {selected.attachments.length
                        ? `${selected.attachments.length} file(s)`
                        : "None"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="detail-tabs">
                <div className="tab-bar">
                  {(["message", "plain", "raw", "json"] as Tab[]).map(
                    (item) => (
                      <button
                        key={item}
                        className={`tab ${tab === item ? "active" : ""}`}
                        onClick={() => setTab(item)}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <div className="tab-content">
                  {tab === "message" &&
                    (selected.html ? (
                      <iframe
                        className="rendered-frame"
                        title="Rendered email"
                        sandbox=""
                        srcDoc={selected.html}
                      />
                    ) : (
                      <pre className="code-block">
                        {selected.text || "(empty)"}
                      </pre>
                    ))}
                  {tab === "plain" && (
                    <pre className="code-block">
                      {selected.text || "(empty)"}
                    </pre>
                  )}
                  {tab === "raw" && (
                    <pre className="code-block">{selected.raw}</pre>
                  )}
                  {tab === "json" && (
                    <pre className="code-block">
                      {JSON.stringify(selected, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </>
          )}

          {error && <div className="error-banner">{error}</div>}
        </section>
      </main>

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
