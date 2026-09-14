import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.Authenticator;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.PasswordAuthentication;
import java.net.Proxy;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;

/**
 * ConnectivityCheck — validate the Relay SOCKS "bridge" before running a real job.
 *
 * It answers three questions:
 *   1. What IP do I egress from directly vs. through the proxy? (proxied should be the AWS box's whitelisted IP)
 *   2. Can I still reach my DB (over VPN / private Route53) with the proxy in effect?
 *   3. Can I open a TCP connection to a vendor host:port through the proxy? (FTP/SFTP/API reachability)
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN (IntelliJ: right-click -> Run, or a Run Config), passing VM options / args.
 *
 * Recommended (mirrors how dmx-core jobs behave with JVM-wide SOCKS):
 *   VM options:
 *     -DsocksProxyHost=your-aws-host -DsocksProxyPort=1080
 *     -Djava.net.socks.username=devproxy -Djava.net.socks.password=a-strong-secret
 *   Program args (optional DB check):
 *     --db-url "jdbc:mysql://your-db.internal.example.com:3306/dmx" --db-user USER --db-pass PASS
 *   Program args (optional TCP reachability, comma-separated host:port):
 *     --tcp "api.woocommerce-store.com:443,sftp.vendor.com:22"
 *
 * The SOCKS credentials are also read from -Djava.net.socks.username/password (Java standard).
 * If you prefer an EXPLICIT proxy test independent of the JVM flags, also pass:
 *   --socks your-aws-host:1080 --socks-user devproxy --socks-pass a-strong-secret
 * ---------------------------------------------------------------------------
 */
public class ConnectivityCheck {

    private static final String[] IP_ENDPOINTS = {
            "https://api.ipify.org",
            "https://checkip.amazonaws.com"
    };

    public static void main(String[] args) {
        Args a = Args.parse(args);

        System.out.println("=========================================================");
        System.out.println(" Relay bridge — ConnectivityCheck");
        System.out.println("=========================================================");

        String socksHostProp = System.getProperty("socksProxyHost");
        String socksPortProp = System.getProperty("socksProxyPort", "1080");
        if (socksHostProp != null) {
            System.out.println("JVM-wide SOCKS: " + socksHostProp + ":" + socksPortProp
                    + (System.getProperty("java.net.socks.username") != null ? " (auth set)" : " (no auth set)"));
        } else {
            System.out.println("JVM-wide SOCKS: not set (-DsocksProxyHost)");
        }
        System.out.println();

        // 1a. Direct egress IP (bypass any proxy).
        System.out.println("[1] Egress IP — DIRECT (no proxy):");
        String directIp = fetchIp(Proxy.NO_PROXY, null);
        System.out.println("     " + orDash(directIp));

        // 1b. Egress IP honoring JVM-wide SOCKS (this is how your integrations will behave).
        System.out.println("[2] Egress IP — via JVM SOCKS settings:");
        String jvmIp = (socksHostProp == null)
                ? "(skipped — no -DsocksProxyHost)"
                : orDash(fetchIp(null /* default selector honors socksProxyHost */, null));
        System.out.println("     " + jvmIp);

        // 1c. Egress IP via an EXPLICIT SOCKS proxy (deterministic, includes auth).
        if (a.socksHost != null) {
            System.out.println("[3] Egress IP — via EXPLICIT SOCKS " + a.socksHost + ":" + a.socksPort + ":");
            Proxy explicit = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress(a.socksHost, a.socksPort));
            Authenticator auth = null;
            if (a.socksUser != null) {
                auth = new Authenticator() {
                    @Override protected PasswordAuthentication getPasswordAuthentication() {
                        if (getRequestorType() == RequestorType.PROXY) {
                            return new PasswordAuthentication(a.socksUser, a.socksPass.toCharArray());
                        }
                        return null;
                    }
                };
            }
            System.out.println("     " + orDash(fetchIp(explicit, auth)));
        } else {
            System.out.println("[3] Egress IP — via EXPLICIT SOCKS: (skipped — pass --socks host:port)");
        }

        System.out.println();
        System.out.println("     Interpretation: [1] should be your local/VPN IP; [2]/[3] should be the");
        System.out.println("     AWS host's whitelisted IP. If [2]/[3] differ from [1], the bridge is working.");
        System.out.println();

        // 2. DB connectivity (honors JVM-wide SOCKS just like your real job).
        System.out.println("[4] Database connectivity:");
        if (a.dbUrl == null) {
            System.out.println("     (skipped — pass --db-url / --db-user / --db-pass)");
        } else {
            checkDb(a.dbUrl, a.dbUser, a.dbPass);
        }

        System.out.println();

        // 3. TCP reachability to vendor endpoints through the proxy.
        System.out.println("[5] TCP reachability (host:port):");
        if (a.tcpTargets.isEmpty()) {
            System.out.println("     (skipped — pass --tcp host:port,host:port)");
        } else {
            Proxy proxyForTcp = null;
            Authenticator authForTcp = null;
            if (a.socksHost != null) {
                proxyForTcp = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress(a.socksHost, a.socksPort));
                if (a.socksUser != null) {
                    authForTcp = new Authenticator() {
                        @Override protected PasswordAuthentication getPasswordAuthentication() {
                            return getRequestorType() == RequestorType.PROXY
                                    ? new PasswordAuthentication(a.socksUser, a.socksPass.toCharArray()) : null;
                        }
                    };
                }
                if (authForTcp != null) Authenticator.setDefault(authForTcp);
            }
            for (String t : a.tcpTargets) {
                checkTcp(t, proxyForTcp);
            }
        }

        System.out.println();
        System.out.println("Done.");
    }

    /** Fetch external IP. proxy == null uses the default ProxySelector (honors -DsocksProxyHost). */
    private static String fetchIp(Proxy proxy, Authenticator explicitAuth) {
        if (explicitAuth != null) Authenticator.setDefault(explicitAuth);
        for (String endpoint : IP_ENDPOINTS) {
            try {
                URL url = new URL(endpoint);
                HttpURLConnection c = (HttpURLConnection) (proxy == null ? url.openConnection() : url.openConnection(proxy));
                c.setConnectTimeout(12000);
                c.setReadTimeout(12000);
                c.setRequestProperty("User-Agent", "Relay-ConnectivityCheck");
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line = r.readLine();
                    if (line != null && !line.isBlank()) return line.trim();
                }
            } catch (Exception e) {
                // try next endpoint
            }
        }
        return null;
    }

    private static void checkDb(String url, String user, String pass) {
        long start = System.currentTimeMillis();
        try (Connection conn = DriverManager.getConnection(url, user, pass)) {
            boolean valid = conn.isValid(8);
            String product = safe(() -> conn.getMetaData().getDatabaseProductName());
            String version = safe(() -> conn.getMetaData().getDatabaseProductVersion());
            // A lightweight round-trip that works on most engines.
            try (Statement st = conn.createStatement()) {
                st.execute("SELECT 1");
            } catch (Exception ignore) {
                // Some engines (e.g. Oracle) need FROM DUAL; isValid() already proved the socket + auth.
            }
            long ms = System.currentTimeMillis() - start;
            System.out.println("     OK  connected in " + ms + " ms · valid=" + valid
                    + " · " + product + " " + version);
        } catch (Exception e) {
            System.out.println("     FAIL " + e.getClass().getSimpleName() + ": " + e.getMessage());
            System.out.println("          (If the proxy host cannot reach the DB, disable JVM SOCKS for the DB —");
            System.out.println("           see README 'Routing a local integration job'.)");
        }
    }

    private static void checkTcp(String target, Proxy proxy) {
        String host;
        int port;
        try {
            int idx = target.lastIndexOf(':');
            host = target.substring(0, idx).trim();
            port = Integer.parseInt(target.substring(idx + 1).trim());
        } catch (Exception e) {
            System.out.println("     SKIP invalid target '" + target + "' (use host:port)");
            return;
        }
        long start = System.currentTimeMillis();
        try (Socket s = (proxy == null) ? new Socket() : new Socket(proxy)) {
            // Through SOCKS: leave the address unresolved so DNS happens at the AWS host (remote DNS).
            // Direct: resolve locally.
            InetSocketAddress addr = (proxy == null)
                    ? new InetSocketAddress(host, port)
                    : InetSocketAddress.createUnresolved(host, port);
            s.connect(addr, 12000);
            long ms = System.currentTimeMillis() - start;
            System.out.println("     OK  " + host + ":" + port + " reachable in " + ms + " ms"
                    + (proxy == null ? " (direct)" : " (via SOCKS)"));
        } catch (Exception e) {
            System.out.println("     FAIL " + host + ":" + port + " — " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private static String orDash(String s) { return s == null ? "(failed to determine)" : s; }

    private interface Sup { String get() throws Exception; }
    private static String safe(Sup s) { try { return s.get(); } catch (Exception e) { return "?"; } }

    /** Minimal arg parser. */
    private static class Args {
        String dbUrl, dbUser, dbPass;
        String socksHost, socksUser, socksPass;
        int socksPort = 1080;
        java.util.List<String> tcpTargets = new java.util.ArrayList<>();

        static Args parse(String[] argv) {
            Args a = new Args();
            for (int i = 0; i < argv.length - 1; i++) {
                String k = argv[i], v = argv[i + 1];
                switch (k) {
                    case "--db-url":   a.dbUrl = v; i++; break;
                    case "--db-user":  a.dbUser = v; i++; break;
                    case "--db-pass":  a.dbPass = v; i++; break;
                    case "--socks-user": a.socksUser = v; i++; break;
                    case "--socks-pass": a.socksPass = v; i++; break;
                    case "--socks":
                        int idx = v.lastIndexOf(':');
                        a.socksHost = v.substring(0, idx);
                        a.socksPort = Integer.parseInt(v.substring(idx + 1));
                        i++; break;
                    case "--tcp":
                        for (String t : v.split(",")) if (!t.isBlank()) a.tcpTargets.add(t.trim());
                        i++; break;
                    default: break;
                }
            }
            return a;
        }
    }
}
