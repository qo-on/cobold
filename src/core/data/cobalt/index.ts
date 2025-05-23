import type { CobaltDownloadParams, SuccessfulCobaltMediaResponse } from "@/core/data/cobalt/download"
import { getDownloadLink } from "@/core/data/cobalt/download"
import type { ApiServer } from "@/core/data/cobalt/server"
import type { DownloadedMediaContent } from "@/core/data/cobalt/tunnel"
import { retrieveTunneledMedia } from "@/core/data/cobalt/tunnel"

import type { Result } from "@/core/utils/result"
import { error, ok } from "@/core/utils/result"
import type { CompoundText, Text } from "@/core/utils/text"
import { compound, literal, translatable } from "@/core/utils/text"
import { safeUrlSchema } from "@/core/utils/url"

export { type CobaltDownloadParams } from "@/core/data/cobalt/download"
export { type ApiServer, apiServerSchema } from "@/core/data/cobalt/server"

export async function download(params: CobaltDownloadParams, apiPool: ApiServer[]): Promise<Result<DownloadedMedia[], Text>> {
    const link = await tryGetDownloadLink(params, apiPool)
    if (!link.success)
        return link
    const resolvedMedia = resolveMedia(link.result, params.downloadMode === "audio")
    const downloadedMedia = await Promise.all(
        resolvedMedia.map(m => downloadResolvedMedia(m, link.result.api)),
    )

    const successfulDownloads = downloadedMedia
        .filter(m => m.success)
        .map(m => m.result)
    const failedDownloads = downloadedMedia
        .filter(m => !m.success)
        .map(m => m.error)
    if (successfulDownloads.length === 0) {
        if (failedDownloads.length === 1)
            return error(compound(literal(`${link.result.api.name}: `), failedDownloads[0]))
        return error(compound(...failedDownloads.map(m => compound(literal(`\n${link.result.api.name}: `), m))))
    }
    return ok(successfulDownloads)
}

export type DownloadedMedia = { file: DownloadedMediaContent, filename?: string }
async function downloadResolvedMedia(link: ResolvedMedia, api: ApiServer): Promise<Result<DownloadedMedia, Text>> {
    if (api.unsafe && !(await safeUrlSchema.safeParseAsync(link.url)).success)
        return error(literal("unsafe url"))
    const file = await retrieveTunneledMedia(link.url, api.proxy)
    if (!file.success)
        return file
    return ok({
        file: file.result,
        filename: link.filename,
    })
}

type ResolvedMedia = { url: string, filename?: string }
function resolveMedia(link: DownloadLink, audio?: boolean): ResolvedMedia[] {
    if (link.status === "picker") {
        if (audio && link.audio) {
            const source = new URL(link.audio)
            return [{ url: link.audio, filename: source.pathname.split("/").at(-1) }]
        }
        return link.picker.map(p => ({ url: p.url, filename: new URL(p.url).pathname.split("/").at(-1) }))
    }
    return [{ url: link.url, filename: link.filename }]
}

type DownloadLink = SuccessfulCobaltMediaResponse & { api: ApiServer }
async function tryGetDownloadLink(params: CobaltDownloadParams, apiPool: ApiServer[], fails: Text[] = []): Promise<Result<DownloadLink, CompoundText>> {
    const currentApi = apiPool.at(0)
    if (!currentApi)
        return error(compound(...fails))

    const next = (reason: Text) =>
        tryGetDownloadLink(
            params,
            apiPool.slice(1),
            [...fails, compound(literal(`\n${currentApi.name}: `), reason)],
        )

    if (currentApi.unsafe && !(await safeUrlSchema.safeParseAsync(currentApi.url)).success)
        return next(translatable("error-invalid-custom-instance"))

    const res = await getDownloadLink(params, currentApi)

    if (!res.success)
        return next(res.error)

    return { success: res.success, result: { ...res.result, api: currentApi } }
}
