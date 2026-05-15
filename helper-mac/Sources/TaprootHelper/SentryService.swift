import Sentry

enum SentryService {
    static func start() {
        guard let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String,
              !dsn.isEmpty else {
            NSLog("[Taproot] SentryDSN not set in Info.plist — Sentry disabled")
            return
        }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = "production"
            options.releaseName = "taproot-helper@\(version)"
            options.tracesSampleRate = 0
            options.beforeSend = { event in
                // Strip vault paths from breadcrumb data — never send local file paths to Sentry.
                event.breadcrumbs?.forEach { crumb in
                    if crumb.data?["path"] != nil { crumb.data?["path"] = "[REDACTED]" }
                    if crumb.data?["vault_path"] != nil { crumb.data?["vault_path"] = "[REDACTED]" }
                }
                return event
            }
        }
        NSLog("[Taproot] Sentry initialized (release: taproot-helper@\(version))")
    }
}
