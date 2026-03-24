import { Resend } from "resend"
import { env } from "$env/dynamic/private"
import { PRIVATE_SUPABASE_SERVICE_ROLE_KEY } from "$env/static/private"
import { PUBLIC_SUPABASE_URL } from "$env/static/public"
import { createClient, type User } from "@supabase/supabase-js"
import type { Database } from "../DatabaseDefinitions"
import handlebars from "handlebars"

// Sends an email to the admin email address.
// Does not throw errors, but logs them.
export const sendAdminEmail = async ({
  subject,
  body,
}: {
  subject: string
  body: string
}): Promise<{ success: boolean }> => {
  // Check admin email is setup
  if (!env.PRIVATE_ADMIN_EMAIL) {
    return { success: false }
  }

  try {
    const resend = new Resend(env.PRIVATE_RESEND_API_KEY)
    const resp = await resend.emails.send({
      from: env.PRIVATE_FROM_ADMIN_EMAIL || env.PRIVATE_ADMIN_EMAIL,
      to: [env.PRIVATE_ADMIN_EMAIL],
      subject: "ADMIN_MAIL: " + subject,
      text: body,
    })

    if (resp.error) {
      console.log("Failed to send admin email, error:", resp.error)
      return { success: false }
    }
    return { success: true }
  } catch (e) {
    console.log("Failed to send admin email, error:", e)
    return { success: false }
  }
}

let _serviceRoleClient: ReturnType<typeof createClient<Database>> | null = null
function getServiceRoleClient() {
  if (!_serviceRoleClient) {
    _serviceRoleClient = createClient<Database>(
      PUBLIC_SUPABASE_URL,
      PRIVATE_SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )
  }
  return _serviceRoleClient
}

export const sendUserEmail = async ({
  user,
  subject,
  from_email,
  template_name,
  template_properties,
}: {
  user: User
  subject: string
  from_email: string
  template_name: string
  template_properties: Record<string, string>
}): Promise<{ success: boolean }> => {
  const email = user.email
  if (!email) {
    console.log("No email for user. Aborting email. ", user.id)
    return { success: false }
  }

  // Check if the user email is verified using the full user object from service role
  // Oauth uses email_verified, and email auth uses email_confirmed_at
  const serverSupabase = getServiceRoleClient()
  const { data: serviceUserData } = await serverSupabase.auth.admin.getUserById(
    user.id,
  )
  const emailVerified =
    serviceUserData.user?.email_confirmed_at ||
    serviceUserData.user?.user_metadata?.email_verified

  if (!emailVerified) {
    console.log("User email not verified. Aborting email. ", user.id, email)
    return { success: false }
  }

  // Fetch user profile to check unsubscribed status
  const { data: profile, error: profileError } = await serverSupabase
    .from("profiles")
    .select("unsubscribed")
    .eq("id", user.id)
    .single()

  if (profileError) {
    console.log("Error fetching user profile. Aborting email. ", user.id, email)
    return { success: false }
  }

  if (profile?.unsubscribed) {
    console.log("User unsubscribed. Aborting email. ", user.id, email)
    return { success: false }
  }

  return await sendTemplatedEmail({
    subject,
    to_emails: [email],
    from_email,
    template_name,
    template_properties,
  })
}

export const sendTemplatedEmail = async ({
  subject,
  to_emails,
  from_email,
  template_name,
  template_properties,
}: {
  subject: string
  to_emails: string[]
  from_email: string
  template_name: string
  template_properties: Record<string, string>
}): Promise<{ success: boolean }> => {
  if (!env.PRIVATE_RESEND_API_KEY) {
    // email not configured.  Emails are optional so no error is thrown
    return { success: false }
  }

  let plaintextBody: string | undefined = undefined
  try {
    const textTemplate = await import(
      `./emails/${template_name}_text.hbs?raw`
    ).then((mod) => mod.default)
    const template = handlebars.compile(textTemplate)
    plaintextBody = template(template_properties)
  } catch {
    // ignore, plaintextBody is optional
    plaintextBody = undefined
  }

  let htmlBody: string | undefined = undefined
  try {
    const htmlTemplate = await import(
      `./emails/${template_name}_html.hbs?raw`
    ).then((mod) => mod.default)
    const template = handlebars.compile(htmlTemplate)
    htmlBody = template(template_properties)
  } catch {
    // ignore, htmlBody is optional
    htmlBody = undefined
  }

  if (!plaintextBody && !htmlBody) {
    console.log(
      "No email body: requires plaintextBody or htmlBody. Template: ",
      template_name,
    )
    return { success: false }
  }

  try {
    const resend = new Resend(env.PRIVATE_RESEND_API_KEY)
    const baseOptions = { from: from_email, to: to_emails, subject: subject }

    let resp
    if (htmlBody) {
      resp = plaintextBody
        ? await resend.emails.send({
            ...baseOptions,
            html: htmlBody,
            text: plaintextBody,
          })
        : await resend.emails.send({ ...baseOptions, html: htmlBody })
    } else {
      resp = await resend.emails.send({ ...baseOptions, text: plaintextBody! })
    }

    if (resp.error) {
      console.log("Failed to send email, error:", resp.error)
      return { success: false }
    }
    return { success: true }
  } catch (e) {
    console.log("Failed to send email, error:", e)
    return { success: false }
  }
}
