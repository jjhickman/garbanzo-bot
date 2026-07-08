{{/*
Expand the name of the chart.
*/}}
{{- define "garbanzo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "garbanzo.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "garbanzo.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{ include "garbanzo.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "garbanzo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "garbanzo.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{/*
Validate supported platform values.
*/}}
{{- define "garbanzo.platform" -}}
{{- if not (or (eq .Values.platform "discord") (eq .Values.platform "whatsapp") (eq .Values.platform "telegram") (eq .Values.platform "matrix")) -}}
{{- fail "platform must be one of: discord, whatsapp, telegram, matrix" -}}
{{- end -}}
{{- .Values.platform -}}
{{- end -}}

{{/*
Secret name for envFrom.
*/}}
{{- define "garbanzo.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- printf "%s-env" (include "garbanzo.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
True when chart-managed config files should be rendered.
*/}}
{{- define "garbanzo.hasConfigFiles" -}}
{{- if or .Values.configFiles.groupsJson .Values.configFiles.discordChannelsJson .Values.configFiles.telegramChatsJson .Values.configFiles.bridgeMapJson .Values.configFiles.ragSourcesJson -}}
true
{{- end -}}
{{- end -}}

{{/*
Qdrant URL used by the bot when the bundled qdrant deployment is enabled.
*/}}
{{- define "garbanzo.qdrantUrl" -}}
{{- if .Values.qdrant.url -}}
{{- .Values.qdrant.url -}}
{{- else -}}
{{- printf "http://%s-qdrant:6333" (include "garbanzo.fullname" .) -}}
{{- end -}}
{{- end -}}
