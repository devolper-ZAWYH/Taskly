import { redirect } from "next/navigation"

/** A workspace's home is its dashboard. */
export default async function WorkspaceHome({
  params,
}: {
  params: Promise<{ accountId: string }>
}) {
  const { accountId } = await params
  redirect(`/w/${accountId}/dashboard`)
}
