FROM decolua/9router:latest

EXPOSE 20128

ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV REQUIRE_API_KEY=true

COPY run-with-seed.js /app/run-with-seed.js

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "run-with-seed.js"]
