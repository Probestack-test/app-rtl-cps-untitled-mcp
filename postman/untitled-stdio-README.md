# MCP Postman collection

Build this server first, then run `postman collection run postman/collections/untitled/ --allow-stdio` with a Postman CLI version that supports MCP collection requests. TypeScript requires `npm install && npm run build`; Python requires its project dependencies. For Java, build the generated Docker image and set the `stdioImage` Postman variable. Set any required environment variables as Postman variables; secret values are never bundled. Each request launches a local server with your permissions.
