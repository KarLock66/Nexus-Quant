"use client";

/**
 * Last-resort error boundary (root layout failure). Must render its own
 * <html>/<body> because the root layout is gone; styling is inlined for the
 * same reason — globals.css may not have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#07090d",
          color: "#d4dae3",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 420,
            padding: 24,
            border: "1px solid #232a37",
            borderRadius: 12,
            background: "rgb(17 21 29 / 0.65)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 16, color: "#f1f5f9" }}>
            Application failed to start
          </h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#94a3b8" }}>
            A fatal rendering error occurred{error.digest ? ` (digest ${error.digest})` : ""}.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              color: "#22d3ee",
              background: "rgb(34 211 238 / 0.1)",
              border: "1px solid rgb(34 211 238 / 0.4)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
