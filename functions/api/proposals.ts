
interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const { results } = await context.env.DB
      .prepare(`
        SELECT
          id,
          title,
          description,
          snapshot_block,
          start_time,
          end_time,
          status
        FROM proposals
        WHERE status IN ('open', 'closed')
        ORDER BY id DESC
        LIMIT 50
      `)
      .all()

    return Response.json({
      success: true,
      proposals: results
    })
  } catch (error) {
    console.error('Database error:', error)

    return Response.json(
      {
        success: false,
        error: 'Unable to load proposals'
      },
      { status: 500 }
    )
  }
}
