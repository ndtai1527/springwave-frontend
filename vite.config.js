import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { execSync } from "child_process";

function cacheBustPlugin() {
  let version;
  return {
    name: "cache-bust",
    buildStart() {
      try {
        version = execSync("git rev-parse --short HEAD").toString().trim();
      } catch {
        version = Date.now().toString(36);
      }
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version, builtAt: new Date().toISOString() }),
      });
    },
    transformIndexHtml(html) {
      const cssPattern = /(<link\s+[^>]*href="\/assets\/style\.css)("[^>]*>)/i;
      html = html.replace(cssPattern, `$1?v=${version}$2`);

      const script =
        `<script>!function(){var n=localStorage.getItem("av"),v="${version}";if(n&&n!==v){localStorage.clear(),sessionStorage.clear(),window.location.href=window.location.pathname+"?v="+Date.now()}localStorage.setItem("av",v)}();</script>`;
      return html.replace("</head>", script + "</head>");
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), cacheBustPlugin()],
  server: {
    proxy: {
      "/cdn-proxy": {
        target: "https://cdn.springwave.io.vn",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cdn-proxy/, ""),
      },
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        login: resolve(__dirname, "login.html"),
        register: resolve(__dirname, "register.html"),
        explore: resolve(__dirname, "explore.html"),
        roadmap: resolve(__dirname, "roadmap.html"),
        profile: resolve(__dirname, "profile.html"),
        hostActivity: resolve(__dirname, "hostActivity.html"),
        completeProfile: resolve(__dirname, "complete-profile.html"),
        verifyEmail: resolve(__dirname, "verify-email.html"),
        community: resolve(__dirname, "community.html"),
        quiz: resolve(__dirname, "quiz.html"),
        about: resolve(__dirname, "about.html"),
        registerHost: resolve(__dirname, "register-host.html"),
        orgDashboard: resolve(__dirname, "org-dashboard.html"),
        orgProfile: resolve(__dirname, "org-profile.html"),
        admin: resolve(__dirname, "admin.html"),
        adminHost: resolve(__dirname, "admin-host.html"),
        myTickets: resolve(__dirname, "my-tickets.html"),
        myEvents: resolve(__dirname, "my-events.html"),
        adminCategories: resolve(__dirname, "admin-categories.html"),
        studentVerify: resolve(__dirname, "student-verify.html"),
        adminStudentVerification: resolve(__dirname, "admin-student-verification.html"),
        adminAnalytics: resolve(__dirname, "admin-analytics.html"),
        adminUniversities: resolve(__dirname, "admin-universities.html"),
        certificate: resolve(__dirname, "certificate.html"),
        policy: resolve(__dirname, "policy.html"),
        kiosk: resolve(__dirname, "kiosk.html"),
      },
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "assets/style.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
