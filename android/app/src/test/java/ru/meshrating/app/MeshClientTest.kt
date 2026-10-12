package ru.meshrating.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Интеграционные JVM-тесты клиента: поднимаем DemoMeshServer (локальный
 * мок school.mos.ru) и проверяем вход, таблицы и автообновление токена.
 */
class MeshClientTest {

    private lateinit var server: DemoMeshServer
    private var port = 0

    /**
     * Свежий сервер на каждый тест: демо-токен живёт только tokenLifetime
     * запросов, поэтому общий сервер делал бы тесты зависимыми от порядка
     * запуска (после первых двух запросов вход по демо-токену уже не проходит).
     */
    @Before
    fun start() {
        server = DemoMeshServer(seed = 7L, classSize = 26, tokenLifetime = 2)
        port = server.start()
    }

    @After
    fun stop() {
        server.stop()
    }

    private fun client(token: String? = DemoMeshServer.DEMO_TOKEN, profileId: String? = null, onToken: ((String) -> Unit)? = null) =
        MeshClient(
            baseUrl = "http://127.0.0.1:$port",
            token = token,
            profileId = profileId,
            timeoutMs = 5_000,
            onToken = onToken
        )

    @Test
    fun `вход по токену подтягивает профиль и ученика`() {
        val result = client().signIn(DemoMeshServer.DEMO_TOKEN)
        assertEquals(DemoMeshServer.DEMO_TOKEN, result.getString("token"))
        val profile = result.getJSONObject("profile")
        assertEquals(2, profile.getJSONArray("children").length())
        assertEquals(DemoMeshServer.UUID_ME, result.getJSONObject("child").getString("personId"))
        assertEquals("17234613", result.getString("profileId"))
    }

    @Test
    fun `рейтинг класса содержит имена, места и сводку`() {
        val rows = client().getRankBoard(DemoMeshServer.UUID_ME, "2026-10-12")
        assertEquals(26, rows.getJSONArray("rows").length())
        val first = rows.getJSONArray("rows").getJSONObject(0)
        assertTrue(first.getString("name").length > 3)
        assertEquals(1, first.getInt("place"))
        val summary = rows.getJSONObject("summary")
        assertTrue(summary.getDouble("classAverage") > 2.0)
        assertTrue(summary.getDouble("classAverage") <= 5.0)
        assertEquals(26, summary.getInt("total"))
        assertTrue(summary.getInt("myPlace") >= 1)
    }

    @Test
    fun `предметы, оценки, домашки и расписание разбираются`() {
        val client = client()
        client.signIn(DemoMeshServer.DEMO_TOKEN)

        val subjects = client.getSubjects(DemoMeshServer.UUID_ME, "2026-10-12")
        assertEquals(14, subjects.length())
        assertNotNull(subjects.getJSONObject(0).opt("average"))

        val marks = client.getMarks("17234613", "2026-09-01", "2026-10-12")
        assertTrue(marks.size > 10)
        assertTrue(MeshCore.summarizeMarks(marks).getDouble("average") > 2.0)

        val homeworks = client.getHomeworks("17234613", "2026-10-05", "2026-10-12")
        assertTrue(homeworks.size > 3)
        assertTrue(homeworks.first().getString("subjectName").isNotEmpty())

        val lessons = client.getSchedule("17234613", "2026-10-12")
        assertEquals(7, lessons.length())

        val subjectMarks = client.getSubjectMarks("17234613")
        assertEquals(14, subjectMarks.length())
    }

    @Test
    fun `при 401 клиент сам обновляет токен и повторяет запрос`() {
        val refreshed = mutableListOf<String>()
        val client = client(onToken = { refreshed.add(it) })
        client.signIn(DemoMeshServer.DEMO_TOKEN)

        // tokenLifetime = 2: на третьем запросе мок вернёт 401
        client.getRank(DemoMeshServer.UUID_ME, "2026-10-12")
        client.getRank(DemoMeshServer.UUID_ME, "2026-10-12")
        val subjects = client.getSubjects(DemoMeshServer.UUID_ME, "2026-10-12")

        assertEquals(14, subjects.length())
        assertEquals(1, refreshed.size)
        assertNotEquals(DemoMeshServer.DEMO_TOKEN, client.token)
        assertTrue(client.token!!.startsWith("mock-token-"))
    }

    @Test
    fun `ошибки сети превращаются в понятный код`() {
        val broken = MeshClient(baseUrl = "http://127.0.0.1:1", token = "A".repeat(32), timeoutMs = 500)
        try {
            broken.getSubjects(DemoMeshServer.UUID_ME, "2026-10-12")
            throw AssertionError("ожидалась ошибка сети")
        } catch (error: MeshCore.MeshError) {
            assertEquals("network", error.code)
            assertTrue(MeshCore.describeError(error).contains("school.mos.ru"))
        }
    }

    @Test
    fun `некорректный токен отклоняется до сети`() {
        // Боевой МЭШ: строгая проверка формата токена
        val strict = MeshClient(baseUrl = MeshCore.HOST, token = null, timeoutMs = 500)
        try {
            strict.signIn("слишком короткая строка")
            throw AssertionError("ожидалась ошибка токена")
        } catch (error: MeshCore.MeshError) {
            assertEquals("bad-token", error.code)
        }
        // Пустой токен отклоняется всегда
        try {
            client().signIn("")
            throw AssertionError("ожидалась ошибка пустого токена")
        } catch (error: MeshCore.MeshError) {
            assertEquals("bad-token", error.code)
        }
    }
}
