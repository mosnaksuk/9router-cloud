FROM decolua/9router:latest

# Expose the default 9Router port
EXPOSE 20128

# Standard cloud runtime environment variables
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV REQUIRE_API_KEY=true

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
