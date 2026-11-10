import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "docs/**", "esbuild.config.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
      },
    },
    rules: {
      // Preserve official brand names and technical acronyms. These options replace
      // the built-in word lists, so retain common defaults alongside GSync terms.
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: [
          "Android", "Chrome", "GSync", "Google", "Google Cloud",
          "Google Cloud Console", "Google Drive", "GitHub", "My Drive",
          "Obsidian", "OAuth", "PayPal", "Safari", "Windows",
        ],
        acronyms: [
          "API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL",
          "FTP", "SFTP", "SMTP", "JSON", "XML", "HTML", "CSS", "PDF", "CSV", "YAML",
          "SQL", "PNG", "JPG", "JPEG", "GIF", "SVG", "2FA", "MFA", "JWT",
          "LDAP", "SAML", "SDK", "IDE", "CLI", "GUI", "CRUD", "REST", "SOAP",
          "CPU", "GPU", "RAM", "SSD", "USB", "UI", "OK", "RSS", "S3",
          "ID", "UUID", "GUID", "SHA", "MD5", "ASCII", "UTF-8", "UTF-16",
          "DOM", "CDN", "FAQ", "AI", "ML", "MB", "URI",
        ],
      }],
    },
  },
]);
