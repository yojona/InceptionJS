#pragma once

#include <limits>
#include <optional>
#include <span>
#include <type_traits>
#include <wtf/URL.h>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

namespace Inception {

// The wire format between engines of one profile (link/Link.h): fixed-width
// little-endian integers, a length before every string and byte run, strings
// as their own code units (Latin-1 or UTF-16) so that what a page stored comes
// back exactly, lone surrogates included. Both ends are the same binary, so
// there is no versioning. A decoder never trusts its input: running past the
// end or meeting an impossible value fails the whole message.
//
// Types cross through Coder<T> (encode/decode), specialized next to the
// module that sends them. Nothing outside Coder specializations knows the
// byte layout, so the codec can be replaced as a whole.
class Encoder;
class Decoder;

template<typename T, typename = void> struct Coder;

class Encoder {
public:
    void u8(uint8_t value) { m_buffer.append(value); }
    void boolean(bool value) { u8(value ? 1 : 0); }
    void u32(uint32_t);
    void u64(uint64_t);
    void i32(int32_t value) { u32(static_cast<uint32_t>(value)); }
    void i64(int64_t value) { u64(static_cast<uint64_t>(value)); }
    void f64(double);
    void string(const String&);
    void bytes(std::span<const uint8_t>);

    template<typename T> Encoder& operator<<(const T& value)
    {
        Coder<T>::encode(*this, value);
        return *this;
    }

    std::span<const uint8_t> span() const { return m_buffer.span(); }
    Vector<uint8_t> take() { return WTF::move(m_buffer); }

private:
    Vector<uint8_t> m_buffer;
};

class Decoder {
public:
    explicit Decoder(std::span<const uint8_t> data)
        : m_data(data)
    {
    }

    std::optional<uint8_t> u8();
    std::optional<bool> boolean();
    std::optional<uint32_t> u32();
    std::optional<uint64_t> u64();
    std::optional<int32_t> i32();
    std::optional<int64_t> i64();
    std::optional<double> f64();
    std::optional<String> string();
    std::optional<Vector<uint8_t>> bytes();
    // A byte run without copying it; valid while the input is.
    std::optional<std::span<const uint8_t>> view();

    // A Coder that returns nothing marks the input bad, so a later read
    // cannot pick up where a refused value stopped part-way.
    template<typename T> std::optional<T> decode()
    {
        auto value = Coder<T>::decode(*this);
        if (!value)
            m_failed = true;
        return value;
    }

    // A collection's size, refused when the rest of the input could not hold
    // that many elements of at least `minimumElementBytes` each.
    std::optional<uint32_t> count(size_t minimumElementBytes = 1);

    bool failed() const { return m_failed; }
    bool atEnd() const { return !m_failed && m_position == m_data.size(); }
    // Marks the input bad (a value decoded but made no sense).
    void fail() { m_failed = true; }

private:
    std::optional<std::span<const uint8_t>> take(size_t);

    std::span<const uint8_t> m_data;
    size_t m_position { 0 };
    bool m_failed { false };
};

// Common types. Strings, URLs and byte vectors; vectors and optionals of
// anything with a Coder.
template<> struct Coder<String> {
    static void encode(Encoder& encoder, const String& value) { encoder.string(value); }
    static std::optional<String> decode(Decoder& decoder) { return decoder.string(); }
};

template<> struct Coder<URL> {
    static void encode(Encoder&, const URL&);
    static std::optional<URL> decode(Decoder&);
};

template<> struct Coder<bool> {
    static void encode(Encoder& encoder, bool value) { encoder.boolean(value); }
    static std::optional<bool> decode(Decoder& decoder) { return decoder.boolean(); }
};

template<typename T> struct Coder<T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>>> {
    static void encode(Encoder& encoder, T value)
    {
        if constexpr (sizeof(T) <= 4)
            encoder.u32(static_cast<uint32_t>(value));
        else
            encoder.u64(static_cast<uint64_t>(value));
    }
    static std::optional<T> decode(Decoder& decoder)
    {
        if constexpr (sizeof(T) <= 4) {
            auto value = decoder.u32();
            if (!value)
                return std::nullopt;
            if constexpr (sizeof(T) < 4) {
                if constexpr (std::is_signed_v<T>) {
                    auto wide = static_cast<int32_t>(*value);
                    if (wide < std::numeric_limits<T>::min() || wide > std::numeric_limits<T>::max()) {
                        decoder.fail();
                        return std::nullopt;
                    }
                    return static_cast<T>(wide);
                } else if (*value > std::numeric_limits<T>::max()) {
                    decoder.fail();
                    return std::nullopt;
                }
            }
            return static_cast<T>(*value);
        } else {
            auto value = decoder.u64();
            if (!value)
                return std::nullopt;
            return static_cast<T>(*value);
        }
    }
};

template<> struct Coder<double> {
    static void encode(Encoder& encoder, double value) { encoder.f64(value); }
    static std::optional<double> decode(Decoder& decoder) { return decoder.f64(); }
};

template<> struct Coder<float> {
    static void encode(Encoder& encoder, float value) { encoder.f64(value); }
    static std::optional<float> decode(Decoder& decoder)
    {
        auto value = decoder.f64();
        if (!value)
            return std::nullopt;
        return static_cast<float>(*value);
    }
};

// Enums: their underlying value, refused above `max` when one is given by a
// specialization of EnumLimit.
template<typename T> struct EnumLimit {
    static constexpr std::optional<uint64_t> max = std::nullopt;
};

template<typename T> struct Coder<T, std::enable_if_t<std::is_enum_v<T>>> {
    using Underlying = std::underlying_type_t<T>;
    static void encode(Encoder& encoder, T value) { Coder<Underlying>::encode(encoder, static_cast<Underlying>(value)); }
    static std::optional<T> decode(Decoder& decoder)
    {
        auto value = Coder<Underlying>::decode(decoder);
        if (!value)
            return std::nullopt;
        if (EnumLimit<T>::max && static_cast<uint64_t>(*value) > *EnumLimit<T>::max) {
            decoder.fail();
            return std::nullopt;
        }
        return static_cast<T>(*value);
    }
};

template<typename T> struct Coder<std::optional<T>> {
    static void encode(Encoder& encoder, const std::optional<T>& value)
    {
        encoder.boolean(!!value);
        if (value)
            encoder << *value;
    }
    static std::optional<std::optional<T>> decode(Decoder& decoder)
    {
        auto present = decoder.boolean();
        if (!present)
            return std::nullopt;
        if (!*present)
            return std::optional<std::optional<T>> { std::optional<T> { } };
        auto value = decoder.decode<T>();
        if (!value)
            return std::nullopt;
        return std::optional<std::optional<T>> { WTF::move(*value) };
    }
};

template<typename T, size_t inlineCapacity> struct Coder<Vector<T, inlineCapacity>> {
    static void encode(Encoder& encoder, const Vector<T, inlineCapacity>& values)
    {
        if constexpr (std::is_same_v<T, uint8_t>)
            encoder.bytes(values.span());
        else {
            encoder.u32(values.size());
            for (auto& value : values)
                encoder << value;
        }
    }
    static std::optional<Vector<T, inlineCapacity>> decode(Decoder& decoder)
    {
        if constexpr (std::is_same_v<T, uint8_t>) {
            auto bytes = decoder.bytes();
            if (!bytes)
                return std::nullopt;
            return Vector<T, inlineCapacity> { bytes->span() };
        } else {
            auto size = decoder.count();
            if (!size)
                return std::nullopt;
            Vector<T, inlineCapacity> values;
            values.reserveInitialCapacity(*size);
            for (uint32_t i = 0; i < *size; ++i) {
                auto value = decoder.decode<T>();
                if (!value)
                    return std::nullopt;
                values.append(WTF::move(*value));
            }
            return values;
        }
    }
};

template<typename A, typename B> struct Coder<std::pair<A, B>> {
    static void encode(Encoder& encoder, const std::pair<A, B>& value) { encoder << value.first << value.second; }
    static std::optional<std::pair<A, B>> decode(Decoder& decoder)
    {
        auto first = decoder.decode<A>();
        auto second = first ? decoder.decode<B>() : std::nullopt;
        if (!second)
            return std::nullopt;
        return std::pair<A, B> { WTF::move(*first), WTF::move(*second) };
    }
};

} // namespace Inception
