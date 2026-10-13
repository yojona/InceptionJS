#include "config.h"
#include "link/Codec.h"

#include <bit>
#include <cstring>

namespace Inception {

// Strings: a tag (0 null, 1 Latin-1, 2 UTF-16), the length in code units,
// then the code units.
static constexpr uint8_t nullString = 0;
static constexpr uint8_t latin1String = 1;
static constexpr uint8_t utf16String = 2;

// No single run is larger than this; the biggest real one (a localStorage
// area, a response body chunk) is far smaller.
static constexpr uint32_t maxRunBytes = 256 * 1024 * 1024;

void Encoder::u32(uint32_t value)
{
    for (unsigned i = 0; i < 4; ++i)
        m_buffer.append(static_cast<uint8_t>(value >> (8 * i)));
}

void Encoder::u64(uint64_t value)
{
    for (unsigned i = 0; i < 8; ++i)
        m_buffer.append(static_cast<uint8_t>(value >> (8 * i)));
}

void Encoder::f64(double value)
{
    u64(std::bit_cast<uint64_t>(value));
}

void Encoder::string(const String& value)
{
    if (value.isNull()) {
        u8(nullString);
        return;
    }
    if (value.is8Bit()) {
        u8(latin1String);
        auto span = value.span8();
        u32(span.size());
        m_buffer.append(std::span { reinterpret_cast<const uint8_t*>(span.data()), span.size() });
        return;
    }
    u8(utf16String);
    auto span = value.span16();
    u32(span.size());
    for (auto unit : span) {
        m_buffer.append(static_cast<uint8_t>(unit));
        m_buffer.append(static_cast<uint8_t>(unit >> 8));
    }
}

void Encoder::bytes(std::span<const uint8_t> data)
{
    u32(data.size());
    m_buffer.append(data);
}

std::optional<std::span<const uint8_t>> Decoder::take(size_t size)
{
    if (m_failed || size > m_data.size() - m_position) {
        m_failed = true;
        return std::nullopt;
    }
    auto span = m_data.subspan(m_position, size);
    m_position += size;
    return span;
}

std::optional<uint8_t> Decoder::u8()
{
    auto span = take(1);
    if (!span)
        return std::nullopt;
    return (*span)[0];
}

std::optional<bool> Decoder::boolean()
{
    auto value = u8();
    if (!value)
        return std::nullopt;
    if (*value > 1) {
        m_failed = true;
        return std::nullopt;
    }
    return *value == 1;
}

std::optional<uint32_t> Decoder::u32()
{
    auto span = take(4);
    if (!span)
        return std::nullopt;
    uint32_t value = 0;
    for (unsigned i = 0; i < 4; ++i)
        value |= static_cast<uint32_t>((*span)[i]) << (8 * i);
    return value;
}

std::optional<uint64_t> Decoder::u64()
{
    auto span = take(8);
    if (!span)
        return std::nullopt;
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i)
        value |= static_cast<uint64_t>((*span)[i]) << (8 * i);
    return value;
}

std::optional<int32_t> Decoder::i32()
{
    auto value = u32();
    if (!value)
        return std::nullopt;
    return static_cast<int32_t>(*value);
}

std::optional<int64_t> Decoder::i64()
{
    auto value = u64();
    if (!value)
        return std::nullopt;
    return static_cast<int64_t>(*value);
}

std::optional<double> Decoder::f64()
{
    auto value = u64();
    if (!value)
        return std::nullopt;
    return std::bit_cast<double>(*value);
}

std::optional<uint32_t> Decoder::count(size_t minimumElementBytes)
{
    auto size = u32();
    if (!size)
        return std::nullopt;
    if (static_cast<uint64_t>(*size) * std::max<size_t>(minimumElementBytes, 1) > m_data.size() - m_position) {
        m_failed = true;
        return std::nullopt;
    }
    return size;
}

std::optional<String> Decoder::string()
{
    auto tag = u8();
    if (!tag)
        return std::nullopt;
    if (*tag == nullString)
        return String { };
    auto length = u32();
    if (!length || *length > maxRunBytes) {
        m_failed = true;
        return std::nullopt;
    }
    if (*tag == latin1String) {
        auto span = take(*length);
        if (!span)
            return std::nullopt;
        return String { std::span { reinterpret_cast<const Latin1Character*>(span->data()), span->size() } };
    }
    if (*tag != utf16String) {
        m_failed = true;
        return std::nullopt;
    }
    auto span = take(static_cast<size_t>(*length) * 2);
    if (!span)
        return std::nullopt;
    Vector<char16_t> units;
    units.appendUsingFunctor(*length, [&](size_t i) {
        return static_cast<char16_t>((*span)[2 * i] | ((*span)[2 * i + 1] << 8));
    });
    return String { units.span() };
}

std::optional<std::span<const uint8_t>> Decoder::view()
{
    auto length = u32();
    if (!length || *length > maxRunBytes) {
        m_failed = true;
        return std::nullopt;
    }
    return take(*length);
}

std::optional<Vector<uint8_t>> Decoder::bytes()
{
    auto span = view();
    if (!span)
        return std::nullopt;
    return Vector<uint8_t> { *span };
}

void Coder<URL>::encode(Encoder& encoder, const URL& url)
{
    encoder.string(url.string());
}

std::optional<URL> Coder<URL>::decode(Decoder& decoder)
{
    auto string = decoder.string();
    if (!string)
        return std::nullopt;
    if (string->isNull())
        return URL { };
    return URL { *string };
}

} // namespace Inception
