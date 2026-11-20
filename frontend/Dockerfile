FROM nginx:1.27-alpine
# A imagem do nginx aplica envsubst nos templates: ${MINIO_BUCKET} vem do docker-compose.yml
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY *.html *.js *.css /usr/share/nginx/html/
EXPOSE 80
